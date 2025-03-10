import { PrismaClient, StepStatus, WorkflowStatus, type WorkflowSteps } from '@prisma/client';
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

		// Create a new step instance
		const stepInstance = await this.prisma.workflowStepInstances.create({
			data: {
				stepId: step.id,
				retries: 0,
				status: StepStatus.RUNNING,
				startedAt: new Date(),
			},
		});

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

				if (retryCount >= retryLimit) {
					// If we've exhausted retries, mark as failed
					await this.prisma.workflowStepInstances.update({
						where: { id: stepInstance.id },
						data: {
							status: StepStatus.FAILED,
							failedReason: lastError.message,
							retries: retryCount,
						},
					});

					// Mark workflow as failed
					await this.prisma.workflowInstances.update({
						where: { id: this.workflowInstanceId },
						data: {
							status: WorkflowStatus.FAILED,
							failedReason: `Step "${name}" failed: ${lastError.message}`,
						},
					});

					throw lastError;
				}

				retryCount++;
			}
		}

		// This should never be reached due to the throw in the catch block
		throw lastError;
	}

	async sleep(name: string, duration: string): Promise<void> {
		const ms = parseDuration(duration);

		// Create a sleep step
		const step = await this.getOrCreateStep(name);

		// Create a step instance
		const stepInstance = await this.prisma.workflowStepInstances.create({
			data: {
				stepId: step.id,
				status: StepStatus.RUNNING,
				startedAt: new Date(),
			},
		});

		// Wait for the specified duration
		await new Promise((resolve) => setTimeout(resolve, ms));

		// Mark the step as completed
		await this.prisma.workflowStepInstances.update({
			where: { id: stepInstance.id },
			data: {
				status: StepStatus.COMPLETED,
				completedAt: new Date(),
			},
		});
	}

	private async getOrCreateStep(name: string) {
		// Check if we already have this step
		if (this.dbStepMap[name]) {
			return { id: this.dbStepMap[name] };
		}

		let theStep: WorkflowSteps;

		const existingStep = await this.prisma.workflowSteps.findUnique({
			where: {
				workflowId_name: {
					workflowId: this.workflowInstanceId,
					name,
				},
			},
		});

		if (!existingStep) {
			// Create or get the step
			const step = await this.prisma.workflowSteps.create({
				data: {
					name,
					workflowId: this.workflowInstanceId,
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
