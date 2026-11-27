/**
 * The seller type and an agency's public facts on every conversation
 * participant the chat API returns - the same `providerType` and `agency`
 * the backend puts on a freelancer profile, a gig card or an order party
 * (seemuehub-backend src/modules/users/agency-profile.ts), so a client shows
 * "Verified Agency" in a chat header exactly as everywhere else.
 *
 * The backend keeps `User.agencyProfile` - a public copy of the agency's
 * Organization - in step; this service only reads it. Never the enterprise
 * registration number, the certificate or `agencyDraft`: none of them is in
 * agencyProfile, and agencyDraft is never selected here.
 *
 * Additive: an old app ignores the two new keys. An account without
 * providerType reads INDIVIDUAL, with `agency: null`.
 */

export const PROVIDER_TYPES = ["INDIVIDUAL", "AGENCY"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

const ORGANIZATION_TYPES = ["COMPANY", "SHOP", "AGENCY", "OTHER"] as const;
type OrganizationType = (typeof ORGANIZATION_TYPES)[number];

/** The user fields a participant populate adds so publicProviderFieldsOf can answer. */
export const PROVIDER_FIELDS = "providerType agencyProfile";

/** What the conversation reads populate for each participant: the fields they always did, plus the provider fields. */
export const PARTICIPANT_FIELDS = `userName displayName isFreelancer phone email role profileImage ${PROVIDER_FIELDS}`;
/** The admin conversation list: the fields it always populated, plus the provider fields. */
export const ADMIN_PARTICIPANT_FIELDS = "userName displayName email profileImage isFreelancer " + PROVIDER_FIELDS;
/** The same, with isOnline, for the reads that always sent it. */
export const PARTICIPANT_FIELDS_ONLINE = `${PARTICIPANT_FIELDS} isOnline`;

export type PublicAgency = {
  /** Provider APPROVED and organization APPROVED, as the backend last copied it. */
  verified: boolean;
  organizationType: OrganizationType | null;
  organizationTypeOther: string | null;
  website: string | null;
  officeAddress: string | null;
  /** The company page: /company/{slug}. */
  slug: string | null;
};

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/** Anything but AGENCY - unset included - is INDIVIDUAL. */
export const providerTypeOf = (user: any): ProviderType => (user?.providerType === "AGENCY" ? "AGENCY" : "INDIVIDUAL");

/** `user`'s public agency block: null for anyone but an AGENCY account. */
export const publicAgencyOf = (user: any): PublicAgency | null => {
  if (providerTypeOf(user) !== "AGENCY") return null;
  const profile = user?.agencyProfile ?? {};
  return {
    verified: profile.verified === true,
    organizationType: (ORGANIZATION_TYPES as readonly string[]).includes(profile.organizationType)
      ? (profile.organizationType as OrganizationType)
      : null,
    organizationTypeOther: text(profile.organizationTypeOther),
    website: text(profile.website),
    officeAddress: text(profile.officeAddress),
    slug: text(profile.slug),
  };
};

const plainOf = (value: any) => (value && typeof value.toJSON === "function" ? value.toJSON() : value);

/**
 * A populated participant user with `providerType` and `agency`, and without
 * the stored agencyProfile (or anything else agency-shaped that was not asked
 * for). An unpopulated user - an id - passes through.
 */
export const withPublicProvider = (user: any) => {
  const plain = plainOf(user);
  if (!plain || typeof plain !== "object" || !("_id" in plain)) return user;
  const { agencyProfile: _stored, agencyDraft: _never, ...rest } = plain;
  return { ...rest, providerType: providerTypeOf(plain), agency: publicAgencyOf(plain) };
};

/**
 * A conversation (a document or a lean object) with every participant's
 * populated user through withPublicProvider. Returns a plain object.
 */
export const withPublicParticipants = <T>(conversation: T): T => {
  const plain = plainOf(conversation);
  if (!plain || typeof plain !== "object" || !Array.isArray(plain.participants)) return plain as T;
  return {
    ...plain,
    participants: plain.participants.map((participant: any) =>
      participant && typeof participant === "object" ? { ...participant, user: withPublicProvider(participant.user) } : participant
    ),
  } as T;
};
