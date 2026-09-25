-- Default online booking party size raised from 12 to 15.
-- Existing rows keep their configured value; only the column default changes.
ALTER TABLE "OnlineBookingSettings" ALTER COLUMN "maxPartySize" SET DEFAULT 15;
