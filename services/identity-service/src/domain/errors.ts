export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid email or password');
    this.name = 'InvalidCredentialsError';
  }
}

export class EmailAlreadyRegisteredError extends Error {
  constructor(email: string) {
    super(`Email ${email} is already registered`);
    this.name = 'EmailAlreadyRegisteredError';
  }
}
