import prisma from '../utils/prisma';

const SYSTEM_USER_ID = '237198da-612e-411c-9ef8-f267c887a9f1';

export class EmailVerificationRequiredError extends Error {
  constructor() {
    super('Email verification required');
    this.name = 'EmailVerificationRequiredError';
  }
}

export async function ensureEmailVerifiedForAi(userId: string): Promise<void> {
  if (userId === SYSTEM_USER_ID) {
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { emailVerified: true },
  });

  if (!user?.emailVerified) {
    throw new EmailVerificationRequiredError();
  }
}
