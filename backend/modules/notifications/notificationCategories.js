/**
 * Notification type → category grouping.
 *
 * Users opt out of EMAIL delivery per category (see NotificationPreference
 * shape on User.notificationPreferences), not per exact `type` — that would
 * be too fine-grained to present as a settings UI and would need a migration
 * every time a module adds a new type. `security` is NEVER opt-out-able:
 * password changes / new-device logins must always reach the user by email.
 *
 * Add new types to TYPE_CATEGORY_MAP as modules introduce them. Anything not
 * listed falls back to 'product' (see categoryForType below) so a forgotten
 * entry fails open to "opt-outable, non-urgent" rather than silently skipping
 * delivery or silently becoming un-opt-out-able.
 */
const CATEGORIES = {
  security:     { label: 'Security',     optOutable: false },
  organization: { label: 'Organization', optOutable: true },
  product:      { label: 'Product',      optOutable: true },
};

const TYPE_CATEGORY_MAP = {
  password_changed:  'security',
  new_device_login:  'security',
  org_invitation:    'organization',
  org_role_changed:  'organization',
  org_member_removed: 'organization',
  file_uploaded:     'product',
};

function categoryForType(type) {
  return TYPE_CATEGORY_MAP[type] || 'product';
}

module.exports = { CATEGORIES, TYPE_CATEGORY_MAP, categoryForType };
