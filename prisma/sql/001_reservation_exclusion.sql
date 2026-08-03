-- Apply AFTER `npx prisma migrate` / `prisma db push`
-- Requires: CREATE EXTENSION btree_gist; (docker/postgres/init.sql)
-- Enforces FR-INV-05: no overlapping active reservations per inventory unit

ALTER TABLE unit_reservations
  DROP CONSTRAINT IF EXISTS unit_reservations_no_overlap;

ALTER TABLE unit_reservations
  ADD CONSTRAINT unit_reservations_no_overlap
  EXCLUDE USING gist (
    inventory_unit_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  )
  WHERE (status IN ('held', 'checked_out'));
