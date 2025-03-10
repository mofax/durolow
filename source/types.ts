export type WorkflowParams = {
	payload: Record<string, any>;
};

export type WorkflowStepOptions = {
	retries?: {
		limit: number;
		delay: string;
		backoff: 'fixed' | 'exponential';
	};
	timeout?: string;
};

export interface IWorkflowStep {
	do<T>(name: string, fnOrOptions: WorkflowStepOptions | (() => Promise<T>), fn?: () => Promise<T>): Promise<T>;
	sleep(name: string, duration: string): Promise<void>;
}

export interface IWorkflow {
	name: string;
	run(event: WorkflowParams, step: IWorkflowStep): Promise<any>;
}

export type WorkflowEnv = Record<string, any>;
