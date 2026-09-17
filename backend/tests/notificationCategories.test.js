// Unit tests for the notification type→category grouping (no infra needed).
const test = require('node:test');
const assert = require('node:assert/strict');

const { CATEGORIES, categoryForType } = require('../modules/notifications/notificationCategories');

test('known types map to their documented category', () => {
  assert.strictEqual(categoryForType('password_changed'), 'security');
  assert.strictEqual(categoryForType('org_invitation'), 'organization');
  assert.strictEqual(categoryForType('file_uploaded'), 'product');
});

test('unknown type falls back to product, not security', () => {
  assert.strictEqual(categoryForType('some_future_type_nobody_registered'), 'product');
});

test('security category is never opt-out-able', () => {
  assert.strictEqual(CATEGORIES.security.optOutable, false);
  assert.strictEqual(CATEGORIES.organization.optOutable, true);
  assert.strictEqual(CATEGORIES.product.optOutable, true);
});
