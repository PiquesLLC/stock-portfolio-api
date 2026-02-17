export class PlanLimitError extends Error {
  limit: number;
  plan: string;

  constructor(limit: number, plan: string) {
    super('limit_reached');
    this.name = 'PlanLimitError';
    this.limit = limit;
    this.plan = plan;
  }
}
