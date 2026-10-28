export interface UserPseudonymizer {
  /** Stable, keyed, non-reversible reference to a user: the raw userId is never stored. */
  pseudonymize(userId: string): string;
}
