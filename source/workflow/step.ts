import {
	PrismaClient,
	StepStatus,
	WorkflowStatus,
	type WorkflowStepInstances,
	type WorkflowSteps,
	type WorkflowSleepInstances,
} from '@prisma/client';
import type { IWorkflowStep, WorkflowStepOptions } from '../types';
import { parseDuration } from '../utils/time';
import { logger } from '../utils/logging';

export class WorkflowStep implements IWorkflowStep {
	private workflowInstanceId: string;
	private prisma: PrismaClient;
	private stepState: Record<string, any> = {};
	private dbStepMap: Record<string, string> = {}; // Maps step names to DB IDs

	constructor(workflowInstanceId: string, prisma: PrismaClient) {
		this.workflowInstanceId = workflowInstanceId;
		this.prisma = prisma;
	}

	async do<T>(name: string, fn: () => Promise<T>): Promise<T>;
	async do<T>(name: string, options: WorkflowStepOptions, fn: () => Promise<T>): Promise<T>;
	async do<T>(
		name: string,
		fnOrOptions: WorkflowStepOptions | (() => Promise<T>),
		fn?: () => Promise<T>
	): Promise<T> {
		logger.info({ name, workflowId: this.workflowInstanceId }, 'Running Step');
		// Determine if first arg is options or function
		const options: WorkflowStepOptions = typeof fnOrOptions === 'function' ? {} : fnOrOptions;
		const executor: () => Promise<T> = typeof fnOrOptions === 'function' ? fnOrOptions : (fn as () => Promise<T>);

		if (!executor) {
			throw new Error('No executor function provided for step');
		}

		// First, create or get the step record
		const step = await this.getOrCreateStep(name);

		const findCompletedInstance = await this.prisma.workflowStepInstances.findFirst({
			where: {
				stepId: step.id,
				status: {
					in: [StepStatus.COMPLETED],
				},
			},
		});

		if (findCompletedInstance) {
			logger.info({ step: name, workflowId: this.workflowInstanceId }, 'Step already completed');
			return findCompletedInstance.output as T;
		}

		const existingInstance = await this.prisma.workflowStepInstances.findFirst({
			where: {
				stepId: step.id,
				status: {
					notIn: [StepStatus.COMPLETED],
				},
			},
		});

		let stepInstance: WorkflowStepInstances;

		if (existingInstance) {
			logger.info({ step: name, workflowId: this.workflowInstanceId }, 'Resuming existing step');
			stepInstance = existingInstance;
		} else {
			logger.info({ step: name, workflowId: this.workflowInstanceId }, 'Creating new step instance');
			stepInstance = await this.prisma.workflowStepInstances.create({
				data: {
					stepId: step.id,
					retries: 0,
					status: StepStatus.RUNNING,
					startedAt: new Date(),
				},
			});
		}

		if (!stepInstance) {
			throw new Error(`step.do: could not initialize step for: ${name}`);
		}

		// Handle timeout if specified
		let timeoutId: Timer | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			if (options.timeout) {
				const timeoutMs = parseDuration(options.timeout);
				timeoutId = setTimeout(() => {
					reject(new Error(`Step "${name}" timed out after ${options.timeout}`));
				}, timeoutMs);
			}
		});

		let result: T;
		let retryCount = 0;
		let lastError: Error | null = null;

		const retryLimit = options.retries?.limit ?? 0;

		while (retryCount <= retryLimit) {
			try {
				// Execute the function or resolve immediately with retry timeout
				if (retryCount > 0 && options.retries?.delay) {
					const delay = parseDuration(options.retries.delay);
					const backoffFactor = options.retries.backoff === 'exponential' ? Math.pow(2, retryCount - 1) : 1;
					const retryDelay = delay * backoffFactor;

					await this.prisma.workflowStepInstances.update({
						where: { id: stepInstance.id },
						data: {
							status: StepStatus.RETRYING,
							retries: retryCount,
						},
					});

					await new Promise((resolve) => setTimeout(resolve, retryDelay));
				}

				// Execute the function with a race against timeout
				result = await Promise.race([executor(), timeoutPromise]);

				// Clear timeout if step completed successfully
				if (timeoutId) {
					clearTimeout(timeoutId);
				}

				// Update step as completed
				await this.prisma.workflowStepInstances.update({
					where: { id: stepInstance.id },
					data: {
						status: StepStatus.COMPLETED,
						output: result as any,
						completedAt: new Date(),
					},
				});

				// Store result in step state
				this.stepState[name] = result;

				return result;
			} catch (error) {
				lastError = error as Error;
				logger.error({ error, workflowId: this.workflowInstanceId }, 'Step error');

				// If we've exhausted retries, mark as failed
				if (retryCount >= retryLimit) {
					await this.prisma.$transaction([
						this.prisma.workflowStepInstances.update({
							where: { id: stepInstance.id },
							data: {
								status: StepStatus.FAILED,
								failedReason: lastError.message,
								retries: retryCount,
							},
						}),
						// Mark workflow as failed
						this.prisma.workflowInstances.update({
							where: { id: this.workflowInstanceId },
							data: {
								status: WorkflowStatus.FAILED,
								failedReason: `Step "${name}" failed: ${lastError.message}`,
							},
						}),
					]);

					// this if{} should terminate execution
					throw lastError;
				}

				retryCount++;
			}
		}

		// Should never reach here
		// But typescript is not happy without it
		throw lastError;
	}

	async sleep(name: string, duration: string): Promise<void> {
		const fnTime = new Date();
		const ms = parseDuration(duration);
		logger.info({ name, duration: ms, workflowId: this.workflowInstanceId }, 'step.sleep has been triggered');

		if (ms > Number.MAX_SAFE_INTEGER) {
			throw new Error(`step.sleep(${name}): duration ${ms} exceeds maximum safe integer`);
		}

		const existingSleepInstance = await this.prisma.workflowSleepInstances.findUnique({
			where: {
				workflowInstanceId_name: {
					workflowInstanceId: this.workflowInstanceId,
					name,
				},
			},
		});

		if (existingSleepInstance && existingSleepInstance.completedAt !== null) {
			logger.info({ name, workflowId: this.workflowInstanceId }, 'Sleep already completed');
			return;
		}

		let sleepInstance: WorkflowSleepInstances;

		if (existingSleepInstance) {
			logger.info({ name, workflowId: this.workflowInstanceId }, 'Resuming existing sleep');
			sleepInstance = existingSleepInstance;
		} else {
			// Create a step instance
			logger.info({ name, workflowId: this.workflowInstanceId }, 'Creating new sleep instance');
			const [txSleepInstance] = await this.prisma.$transaction([
				this.prisma.workflowSleepInstances.create({
					data: {
						name,
						duration: ms,
						workflowInstanceId: this.workflowInstanceId,
						startedAt: fnTime,
					},
				}),
				this.prisma.workflowInstances.update({
					where: { id: this.workflowInstanceId },
					data: {
						status: WorkflowStatus.SLEEPING,
					},
				}),
			]);
			sleepInstance = txSleepInstance;
		}

		const remainingSleepTime =
			Number(sleepInstance.duration) - (fnTime.getTime() - sleepInstance.startedAt.getTime());

		// Wait for the specified duration
		await new Promise((resolve) => setTimeout(resolve, remainingSleepTime));

		await this.prisma.$transaction([
			// Mark the sleep as completed
			this.prisma.workflowSleepInstances.update({
				where: { id: sleepInstance.id },
				data: {
					completedAt: new Date(),
				},
			}),
			this.prisma.workflowInstances.update({
				where: { id: this.workflowInstanceId },
				data: {
					status: WorkflowStatus.RUNNING,
				},
			}),
		]);
	}

	private async getOrCreateStep(name: string) {
		// Check if we already have this step
		if (this.dbStepMap[name]) {
			return { id: this.dbStepMap[name] };
		}

		let theStep: WorkflowSteps;

		const existingStep = await this.prisma.workflowSteps.findUnique({
			where: {
				workflowInstanceId_name: {
					workflowInstanceId: this.workflowInstanceId,
					name,
				},
			},
		});

		if (!existingStep) {
			// Create or get the step
			const step = await this.prisma.workflowSteps.create({
				data: {
					name,
					workflowInstanceId: this.workflowInstanceId,
				},
			});

			theStep = step;
		} else {
			theStep = existingStep;
		}

		if (!theStep) {
			throw new Error(`getOrCreateStep: error initializing step for: ${name}`);
		}

		this.dbStepMap[name] = theStep.id;
		return theStep;
	}

	// Helper to get state from a previous step
	getStateFromStep(stepName: string): any {
		return this.stepState[stepName];
	}
}
