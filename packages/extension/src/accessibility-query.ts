export interface AccessibilityQuery {
  role?: string;
  name?: string;
}

/** Match the exposed accessible name only, not description or value. */
export function accessibilityMatcher(query: AccessibilityQuery | undefined): (role: string, name: string) => boolean {
  const role = query?.role?.toLowerCase();
  const name = query?.name?.toLowerCase();
  return (nodeRole, nodeName) =>
    (role === undefined || nodeRole.toLowerCase() === role) &&
    (name === undefined || nodeName.toLowerCase().includes(name));
}
