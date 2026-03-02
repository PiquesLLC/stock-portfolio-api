import prisma from '../utils/prisma';

export class EmailVerificationRequiredError extends Error {
  constructor() {
    super('Email verification required');
    this.name = 'EmailVerificationRequiredError';
  }
}

// Hardcoded system user ID — matches the seed user in index.ts
const SYSTEM_USER_ID = '515d3ef4-2b46-4133-8c08-84327b420eba';

export async function ensureEmailVerifiedForAi(userId: string): Promise<void> {
  // System user (no email) is always allowed — check by ID, not username
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
