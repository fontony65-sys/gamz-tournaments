-- Per-account preferences (theme follows the account across devices).
ALTER TABLE users ADD COLUMN theme TEXT CHECK (theme IN ('dark','light'));
