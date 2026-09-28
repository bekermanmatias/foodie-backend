-- Bring existing installations that still use Foodie's previous default in line
-- with the new 15-person online booking default. Lower custom limits remain intact.
UPDATE "OnlineBookingSettings"
SET "maxPartySize" = 15
WHERE "maxPartySize" = 12;
