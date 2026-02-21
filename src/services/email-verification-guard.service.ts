import prisma from '../utils/prisma';

export class EmailVerificationRequiredError extends Error {
  constructor() {
    super('Email verification required');
    this.name = 'EmailVerificationRequiredError';
  }
}

export async function ensureEmailVerifiedForAi(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { emailVerified: true, username: true },
  });

  // System user (no email) is always allowed
  if (user?.username === '_system') {
    return;
  }

  if (!user?.emailVerified) {
    throw new EmailVerificationRequiredError();
  }
}
