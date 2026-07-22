export interface FrameworkTool<Input, Output> {
  name: string;
  description: string;
  execute(input: Input): Promise<Output>;
}
