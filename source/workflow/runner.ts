import { PrismaClient, WorkflowStatus } from '@prisma/client';
import { WorkflowStep } from './step';
import type { IWorkflow, WorkflowParams, WorkflowEnv } from '../types';
import { logger } from '../utils/logging';
import { Err, Ok, type Result } from '../utils/result';

export class WorkflowRunner<T extends IWorkflow = IWorkflow> {
	private prisma: PrismaClient;
	private WorkflowClass: new () => T;
	private env: WorkflowEnv;

	constructor(WorkflowClass: new () => T, prisma: PrismaClient, env: WorkflowEnv = {}) {
		this.prisma = prisma;
		this.WorkflowClass = WorkflowClass;
		this.env = env;
	}

	async run(params: WorkflowParams): Promise<Result<string>> {
		let workflowId: string | null = null;
		try {
			// Create the workflow instance
			const workflow = new this.WorkflowClass();

			// Create workflow instance in database
			const workflowInstance = await this.prisma.workflowInstances.create({
				data: {
					name: workflow.name,
					status: WorkflowStatus.PENDING,
					input: params as any,
				},
			});

			workflowId = workflowInstance.id;

			// Inject environment variables
			(workflow as any).env = this.env;

			// Create workflow step handler
			const step = new WorkflowStep(workflowInstance.id, this.prisma);

			// Start running the workflow
			await this.prisma.workflowInstances.update({
				where: { id: workflowInstance.id },
				data: { status: WorkflowStatus.RUNNING },
			});

			// Run the workflow
			const result = await workflow.run(params, step);

			// Mark workflow as completed
			await this.prisma.workflowInstances.update({
				where: { id: workflowInstance.id },
				data: {
					status: WorkflowStatus.COMPLETED,
					completedAt: new Date(),
					output: result as any,
				},
			});

			return Ok(workflowInstance.id);
		} catch (error) {
			// Mark workflow as failed
			if (!workflowId) {
				logger.error('Error: Could not instanciate workflow');
			} else {
				await this.prisma.workflowInstances.update({
					where: { id: workflowId },
					data: {
						status: WorkflowStatus.FAILED,
						failedReason: (error as Error).message,
					},
				});
			}

			return Err(error as Error);
		}
	}

	async cancel(workflowId: string): Promise<void> {
		await this.prisma.workflowInstances.update({
			where: { id: workflowId },
			data: { status: WorkflowStatus.CANCELED },
		});
	}

	async getWorkflowState(workflowId: string) {
		return this.prisma.workflowInstances.findUnique({
			where: { id: workflowId },
			include: {
				steps: {
					include: {
						instances: true,
					},
				},
			},
		});
	}
}
