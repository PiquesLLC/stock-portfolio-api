import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid';
import { config } from '../config';
import { encrypt, decrypt } from '../utils/encryption';
import prisma from '../utils/prisma';

const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[config.plaidEnv],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': config.plaidClientId,
      'PLAID-SECRET': config.plaidSecret,
    },
  },
});

const plaidClient = new PlaidApi(plaidConfig);

/**
 * Create a Link token for initializing Plaid Link in the frontend.
 */
export async function createLinkToken(userId: string): Promise<string> {
  const response = await plaidClient.linkTokenCreate({
    user: { client_user_id: userId },
    client_name: 'Nala',
    products: [Products.Investments],
    country_codes: [CountryCode.Us],
    language: 'en',
  });
  return response.data.link_token;
}

/**
 * Exchange a public token for an access token, encrypt it, and store it.
 */
export async function exchangePublicToken(
  userId: string,
  publicToken: string
): Promise<{ itemId: string; accounts: Array<{ id: string; name: string | null; mask: string | null; type: string | null }> }> {
  const response = await plaidClient.itemPublicTokenExchange({
    public_token: publicToken,
  });

  const { access_token, item_id } = response.data;

  // Encrypt access token before storing
  const accessTokenEnc = encrypt(access_token);

  // Get institution info
  const itemResponse = await plaidClient.itemGet({ access_token });
  const institutionId = itemResponse.data.item.institution_id || null;
  let institutionName: string | null = null;
  if (institutionId) {
    try {
      const instResponse = await plaidClient.institutionsGetById({
        institution_id: institutionId,
        country_codes: [CountryCode.Us],
      });
      institutionName = instResponse.data.institution.name;
    } catch {
      // Non-critical — proceed without institution name
    }
  }

  const consentExpiresAt = itemResponse.data.item.consent_expiration_time
    ? new Date(itemResponse.data.item.consent_expiration_time)
    : null;

  // Get accounts
  const accountsResponse = await plaidClient.accountsGet({ access_token });
  const plaidAccounts = accountsResponse.data.accounts;

  // Store everything in a transaction
  const plaidItem = await prisma.$transaction(async (tx) => {
    const item = await tx.plaidItem.create({
      data: {
        userId,
        plaidItemId: item_id,
        accessTokenEnc,
        institutionId,
        institutionName,
        consentExpiresAt,
      },
    });

    for (const acct of plaidAccounts) {
      await tx.plaidAccount.create({
        data: {
          plaidItemId: item.id,
          plaidAccountId: acct.account_id,
          name: acct.name,
          officialName: acct.official_name,
          type: acct.type,
          subtype: acct.subtype,
          mask: acct.mask,
        },
      });
    }

    return item;
  });

  return {
    itemId: plaidItem.id,
    accounts: plaidAccounts.map((a) => ({
      id: a.account_id,
      name: a.name,
      mask: a.mask,
      type: a.type,
    })),
  };
}

/**
 * Get decrypted access token for a Plaid item (internal use only).
 */
export async function getDecryptedAccessToken(plaidItemId: string, userId: string): Promise<string | null> {
  const item = await prisma.plaidItem.findFirst({
    where: { id: plaidItemId, userId, status: 'active' },
    select: { accessTokenEnc: true },
  });
  if (!item) return null;
  return decrypt(item.accessTokenEnc);
}

/**
 * List all Plaid items for a user (without access tokens).
 */
export async function getPlaidItems(userId: string) {
  return prisma.plaidItem.findMany({
    where: { userId },
    select: {
      id: true,
      institutionId: true,
      institutionName: true,
      status: true,
      consentExpiresAt: true,
      errorCode: true,
      errorMessage: true,
      createdAt: true,
      plaidAccounts: {
        select: {
          id: true,
          plaidAccountId: true,
          name: true,
          officialName: true,
          type: true,
          subtype: true,
          mask: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Disconnect a Plaid item: revoke access token with Plaid and mark as revoked.
 */
export async function disconnectPlaidItem(plaidItemId: string, userId: string): Promise<boolean> {
  const item = await prisma.plaidItem.findFirst({
    where: { id: plaidItemId, userId },
    select: { accessTokenEnc: true, status: true },
  });

  if (!item) return false;

  // Revoke with Plaid if still active
  if (item.status === 'active') {
    try {
      const accessToken = decrypt(item.accessTokenEnc);
      await plaidClient.itemRemove({ access_token: accessToken });
    } catch {
      // Best effort — still mark as revoked locally
    }
  }

  await prisma.plaidItem.update({
    where: { id: plaidItemId },
    data: { status: 'revoked' },
  });

  return true;
}

/**
 * Handle Plaid webhook updates (item status changes, errors, etc.)
 */
export async function handleItemWebhook(
  webhookType: string,
  webhookCode: string,
  itemId: string,
  error?: { error_code: string; error_message: string }
): Promise<void> {
  if (webhookType !== 'ITEM') return;

  const item = await prisma.plaidItem.findUnique({
    where: { plaidItemId: itemId },
  });
  if (!item) return;

  switch (webhookCode) {
    case 'ERROR':
      await prisma.plaidItem.update({
        where: { id: item.id },
        data: {
          status: 'error',
          errorCode: error?.error_code || null,
          errorMessage: error?.error_message || null,
        },
      });
      break;
    case 'PENDING_EXPIRATION':
      // Consent expiring soon — flag for re-auth
      await prisma.plaidItem.update({
        where: { id: item.id },
        data: { status: 'suspended' },
      });
      break;
  }
}
