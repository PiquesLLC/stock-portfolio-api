# Piques LLC — Information Security Policy

**Document Version:** 1.1
**Effective Date:** February 16, 2026
**Last Reviewed:** February 16, 2026
**Owner:** Jon Paul Piques, Founder & CEO
**Company:** Piques LLC
**Product:** Nala — Portfolio Tracking Application
**Contact:** security@piques.io

---

## 1. Purpose & Scope

This policy establishes the information security requirements for Piques LLC ("the Company") and its product Nala ("the Application"). It applies to all systems, data, personnel, and third-party integrations involved in the development, deployment, and operation of the Application.

This policy covers:
- Application security controls
- Data protection and encryption
- Access management
- Incident response
- Vulnerability management
- Third-party integrations (including Plaid)
- Privacy and compliance

---

## 2. Data Classification

| Classification | Description | Examples | Handling |
|---------------|-------------|----------|----------|
| **Restricted** | Highly sensitive credentials and secrets | API keys, Plaid access tokens, encryption keys, JWT signing secrets | Encrypted at rest (AES-256-GCM), never logged, never included in API responses, environment variables only |
| **Confidential** | User authentication data | Passwords, MFA secrets, TOTP seeds, backup codes, email OTP codes | Hashed (bcrypt) or encrypted (AES-256-GCM), never returned in API responses |
| **Private** | User personal and financial data | Email addresses, portfolio holdings, transaction history, linked account info | Access-controlled per user, transmitted over TLS only, deleted on account removal |
| **Internal** | Operational data | Application logs, error reports, cache data | Access restricted to authorized personnel, no PII in logs |
| **Public** | Non-sensitive data | Privacy policy, terms of service, public market data | No special handling required |

---

## 3. Authentication & Access Control

### 3.1 User Authentication
- **Passwords**: Minimum 8 characters, must include uppercase, lowercase, and numeric characters. Hashed using bcrypt with a cost factor of 10. Plaintext passwords are never stored or logged.
- **Multi-Factor Authentication (MFA)**: Supported via TOTP (authenticator apps) and email-based OTP. Users may enable MFA for enhanced account security. MFA enforcement before sensitive financial integrations (e.g., Plaid Link) is planned for a future release; currently MFA is opt-in.
- **Backup Codes**: 10 single-use recovery codes generated per MFA enrollment, stored as bcrypt hashes.
- **Session Management**: JSON Web Tokens (JWT) with short-lived access tokens and rotating refresh tokens. Tokens stored in httpOnly, secure, sameSite cookies. Refresh tokens are single-use with atomic rotation to prevent replay attacks.

### 3.2 Infrastructure Access
- **Production Environment**: Hosted on Railway (PaaS). Access to the Railway dashboard requires authenticated accounts with MFA enabled.
- **Source Code**: Hosted on GitHub under the PiquesLLC organization. Repository access requires authenticated GitHub accounts with MFA enabled.
- **Database**: SQLite database accessed exclusively through the application layer (Prisma ORM). No direct database access is exposed externally. Database files are stored on Railway's encrypted infrastructure.
- **Secrets Management**: All secrets (API keys, encryption keys, JWT signing keys) are stored as environment variables in Railway's encrypted secrets store. Secrets are never committed to source code or logged.

### 3.3 Principle of Least Privilege
- API endpoints enforce user-scoped access control. Authenticated user identity is derived from JWT tokens, not client-supplied parameters. Controllers use `req.user.userId` to scope all queries.
- Ownership verification is enforced at the service layer: all read, update, and delete operations on user-specific resources (alerts, price alerts, transactions, Plaid items) verify that the resource belongs to the authenticated user before proceeding.
- Sensitive operations (account deletion, MFA changes) require password re-verification.

---

## 4. Encryption & Data Protection

### 4.1 Encryption in Transit
- All client-server communication uses HTTPS with TLS 1.2 or higher.
- HTTP Strict Transport Security (HSTS) is enforced with a max-age of 1 year and includeSubDomains.
- Railway's reverse proxy terminates TLS with modern cipher suites.
- API cookies are set with the `secure` flag, ensuring they are only transmitted over HTTPS.

### 4.2 Encryption at Rest
- **Plaid Access Tokens**: Encrypted using AES-256-GCM before storage. Each token is encrypted with a unique 96-bit initialization vector (IV). The encrypted format stores IV, ciphertext, and authentication tag separately for integrity verification.
- **MFA TOTP Secrets**: Encrypted using the same AES-256-GCM scheme.
- **Passwords**: One-way hashed using bcrypt (not reversible).
- **MFA Backup Codes & Email OTPs**: One-way hashed using bcrypt.
- **Encryption Key Management**: The AES-256 encryption key is a 256-bit key stored as a 64-character hex string in environment variables. The key format is validated at application startup (must be exactly 64 hex characters) — the application will not start if the key is missing in production or malformed in any environment.

### 4.3 Data Minimization
- The Application only collects data necessary for its portfolio tracking functionality.
- Plaid integration is limited to the Investments product scope. The Application does not request access to transactions, identity, or other Plaid products beyond what is needed.
- Plaid account metadata stored locally is limited to: account name, type, subtype, and last 4 digits (mask). Full account numbers are never stored.

---

## 5. Third-Party Integration Security (Plaid)

### 5.1 Plaid Integration Architecture
- **Plaid Link**: Users connect brokerage accounts through Plaid Link, a client-side component that communicates directly with Plaid. The Application never sees or handles user brokerage credentials.
- **Token Exchange**: After successful Link flow, a public token is exchanged server-side for an access token, which is immediately encrypted and stored.
- **Access Token Lifecycle**: Tokens are encrypted at rest, decrypted only when making API calls to Plaid, and revoked (via Plaid's itemRemove API) when a user disconnects an account.
- **Consent Tracking**: Plaid consent expiration dates are tracked per linked item. Items approaching expiration are flagged for re-authorization.

### 5.2 Webhook Security
- Plaid webhooks are received at a dedicated endpoint (`/plaid/webhook`).
- In sandbox/development mode, webhooks are accepted without signature verification for testing purposes.
- In production, the webhook endpoint validates the `Plaid-Verification` header and rejects requests missing it. Full JWT signature verification using Plaid's public key rotation endpoint is in development and will be completed before production Plaid access is enabled.
- Webhook processing is limited to item status updates (errors, consent expiration). No financial data is modified through webhooks.

### 5.3 Plaid Data Handling
- Access tokens: Encrypted (AES-256-GCM) — never exposed in API responses.
- Institution metadata: Stored for display purposes only.
- Account identifiers: Plaid's account_id stored for reference; no full account numbers.
- Investment holdings: Retrieved on-demand via Plaid API, cached temporarily, not permanently stored.

---

## 6. Application Security

### 6.1 Input Validation
- Security-critical API endpoints (authentication, MFA, Plaid token exchange, account deletion) validate input using Zod schema validation. Remaining endpoints use inline validation checks; migration to Zod is ongoing.
- Database queries use Prisma ORM with parameterized queries, preventing SQL injection.
- Content Security Policy (CSP) headers restrict script and resource loading to prevent XSS.

### 6.2 Rate Limiting
- **Login**: 10 attempts per 15 minutes per IP (production), with successful request bypass.
- **Signup**: 5 attempts per hour per IP.
- **MFA Verification**: 5 attempts per 15 minutes per IP.
- **MFA Code Sending**: 3 sends per 15 minutes per IP (prevents email spam).
- **Mutations**: 30 requests per minute per IP applied to POST/PUT/DELETE operations across all authenticated routes including alerts, price alerts, transactions, and Plaid endpoints.
- **Username Enumeration**: 20 attempts per 15 minutes per IP.

### 6.3 Security Headers
- **Content-Security-Policy**: Restricts resource loading to same-origin and explicitly allowed domains.
- **Strict-Transport-Security**: Enforces HTTPS for 1 year with subdomain inclusion.
- **X-Frame-Options**: Prevents clickjacking via frame embedding.
- **X-Content-Type-Options**: Prevents MIME type sniffing.
- **Referrer-Policy**: Limits referrer information leakage.
- Headers are applied via the Helmet middleware.

### 6.4 Error Handling
- Production error responses return generic messages without stack traces or internal details.
- Error logging outputs error messages only; sensitive data (passwords, tokens, keys, user PII) is never included in log output. Debug-level logging is disabled in production.
- Unhandled errors are caught by a global error handler that returns a safe 500 response.

---

## 7. Vulnerability Management

### 7.1 Dependency Scanning
- **Dependabot**: Configured for weekly automated scans of npm dependencies (every Monday). Pull requests are created automatically for vulnerable or outdated packages, with a limit of 10 open PRs.
- **npm audit**: Run before each deployment to identify known vulnerabilities in the dependency tree. As of the latest audit, the project has 0 known vulnerabilities.
- **Patch Policy**: Critical and high-severity vulnerabilities are patched within 7 days. Medium-severity within 30 days.

### 7.2 Code Review
- All code changes are reviewed before deployment.
- Security-sensitive changes (authentication, encryption, Plaid integration, access control) receive additional scrutiny.
- TypeScript strict mode is used to catch type errors at compile time.

### 7.3 Secure Development Practices
- Secrets are never committed to source code repositories.
- `.env` files are excluded from version control via `.gitignore`.
- Environment variable templates (`.env.example`) document required variables without values.
- Production deployments use Railway's encrypted environment variable store.

---

## 8. Incident Response

### 8.1 Incident Classification

| Severity | Description | Response Time | Examples |
|----------|-------------|---------------|----------|
| **Critical** | Active breach or data exposure | Immediate (within 1 hour) | Unauthorized data access, leaked credentials, compromised encryption keys |
| **High** | Vulnerability with high exploitation potential | Within 24 hours | Authentication bypass, unencrypted sensitive data, exposed API keys |
| **Medium** | Vulnerability with limited impact | Within 7 days | Missing rate limiting, verbose error messages, outdated dependencies with known CVEs |
| **Low** | Minor security improvement | Within 30 days | Header configuration, logging improvements |

### 8.2 Response Procedure
1. **Detect**: Identify the incident through monitoring, user reports, or automated alerts.
2. **Contain**: Immediately isolate affected systems. Revoke compromised credentials. If Plaid tokens are compromised, call Plaid's itemRemove API to revoke access.
3. **Assess**: Determine the scope, affected users, and data involved.
4. **Remediate**: Apply fixes, rotate affected secrets, deploy patches.
5. **Notify**: Notify affected users within 72 hours of confirmed data breach. Notify Plaid if their integration is involved. Comply with applicable state data breach notification laws.
6. **Review**: Conduct post-incident review and update security controls as needed.

### 8.3 Contact
- Security issues: security@piques.io
- Plaid integration issues: Escalate through Plaid Dashboard support.

---

## 9. Privacy & Data Retention

### 9.1 Data Collection
The Application collects only data necessary for portfolio tracking:
- Account credentials (username, hashed password, email)
- Portfolio data (holdings, transactions, watchlists)
- Linked brokerage connections (via Plaid — encrypted tokens and account metadata)
- Usage data (consent records with timestamps and IP addresses)

### 9.2 Data Retention
- **Active accounts**: Data is retained for the duration of the account.
- **Deleted accounts**: All user data is permanently and immediately deleted upon account deletion, including: authentication data, MFA credentials, portfolio data, linked accounts (Plaid tokens revoked and deleted), watchlists, notifications, consent records, and all associated metadata.
- **No soft deletes**: Account deletion is permanent and irreversible.

### 9.3 User Rights
- **Access**: Users can view all their stored data through the Application interface.
- **Export**: Users can export portfolio data as CSV.
- **Correction**: Users can update their account information.
- **Deletion**: Users can permanently delete their account and all associated data.

### 9.4 Consent
- Users must explicitly accept the Privacy Policy and Terms of Service during signup.
- Consent is recorded with timestamp, IP address, user agent, and policy version.
- Plaid data access requires explicit user action through Plaid Link.

---

## 10. Compliance

### 10.1 Applicable Regulations
- **CCPA** (California Consumer Privacy Act): Users have the right to know what data is collected, request deletion, and opt out of data sales. The Application does not sell user data.
- **State Data Breach Laws**: The Company will comply with applicable state data breach notification requirements.
- **Plaid Requirements**: The Company complies with Plaid's security diligence requirements, data handling policies, and integration guidelines.

### 10.2 Policy Review
This policy is reviewed and updated at minimum annually, or whenever significant changes are made to the Application's security architecture, data handling practices, or third-party integrations.

---

## 11. Policy Acknowledgment

This Information Security Policy has been approved and is effective as of the date listed above.

**Jon Paul Piques**
Founder & CEO, Piques LLC
February 16, 2026
