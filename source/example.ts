import { PrismaClient } from '@prisma/client';
import type { WorkflowParams, IWorkflow } from './types';
import { WorkflowRunner } from './workflow/runner';
import type { WorkflowStep } from './workflow/step';

export class MyWorkflow implements IWorkflow {
	// Environment variables and configuration
	name = 'MyWorkflow';
	env: Record<string, any> = {};

	async run(event: WorkflowParams, step: WorkflowStep): Promise<any> {
		// Can access bindings on `this.env`
		// Can access params on `event.payload`
		console.log('Running workflow with event:', event);
		const files = await step.do('my first step', async () => {
			// Fetch a list of files from $SOME_SERVICE
			return {
				files: [
					'doc_7392_rev3.pdf',
					'report_x29_final.pdf',
					'memo_2024_05_12.pdf',
					'file_089_update.pdf',
					'proj_alpha_v2.pdf',
					'data_analysis_q2.pdf',
					'notes_meeting_52.pdf',
					'summary_fy24_draft.pdf',
				],
			};
		});

		console.log('Files fetched:', files.files);

		const apiResponse = await step.do('some other step', async () => {
			let resp = await fetch('https://api.cloudflare.com/client/v4/ips');
			return await resp.json();
		});

		console.log('API response:', apiResponse);
		console.log('Waiting for 2 seconds...');
		await step.sleep('wait on something', '2 seconds');

		console.log('Sleep done');

		const aDate = await step.do('get a date', async () => {
			return new Date();
		});

		await step.do(
			'make a call to write that could maybe, just might, fail',
			// Define a retry strategy
			{
				retries: {
					limit: 5,
					delay: '5 second',
					backoff: 'exponential',
				},
				timeout: '15 minutes',
			},
			async () => {
				// Do stuff here, with access to the state from our previous steps
				if (Math.random() > 0.5) {
					throw new Error('API call to $STORAGE_SYSTEM failed');
				}

				// Access data from previous steps
				const fileList = files.files;
				const cloudflareIps = apiResponse.result;

				return {
					aDate: aDate,
					processedFiles: fileList.length,
					ipCount: cloudflareIps?.length || 0,
				};
			}
		);

		return {
			status: 'success',
			message: 'Workflow completed successfully',
		};
	}
}

async function runExample() {
	const prisma = new PrismaClient();

	// Create a workflow runner with environment variables
	const runner = new WorkflowRunner(MyWorkflow, prisma, {
		API_KEY: process.env.API_KEY,
		ENVIRONMENT: process.env.NODE_ENV,
	});

	try {
		// Run the workflow with parameters
		const [error, workflowId] = await runner.run({
			payload: {
				userId: '123',
				action: 'process_files',
			},
		});

		if (error) {
			return console.error('Workflow execution failed:', error);
		}

		console.log(`Workflow started with ID: ${workflowId}`);

		const state = await runner.getWorkflowState(workflowId);
		console.log(`Workflow status: ${state?.status}`);

		return workflowId;
	} catch (error) {
		console.error('Workflow execution failed:', error);
	}
}

runExample()
	.catch(console.error)
	.finally(async () => {
		const prisma = new PrismaClient();
		await prisma.$disconnect();
	});
