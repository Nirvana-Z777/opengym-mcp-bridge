export class PlanError extends Error {
  constructor(message, code = 'validation') {
    super(message);
    this.name = 'PlanError';
    this.code = code;
  }
}
