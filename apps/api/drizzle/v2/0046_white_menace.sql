CREATE OR REPLACE FUNCTION "v2"."allocate_session_message_sequence"("p_session_id" uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $$
DECLARE
  next_sequence integer;
BEGIN
  PERFORM 1
  FROM v2.space_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'space session % does not exist', p_session_id
      USING ERRCODE = '23503';
  END IF;

  SELECT coalesce(max(sequence), 0)::integer + 1
  INTO next_sequence
  FROM v2.session_messages
  WHERE session_id = p_session_id;

  RETURN next_sequence;
END;
$$;--> statement-breakpoint
ALTER TABLE "v2"."session_messages" ADD CONSTRAINT "v2_chk_session_messages_sequence" CHECK ("v2"."session_messages"."sequence" > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "v2"."session_turns" ADD CONSTRAINT "v2_chk_session_turns_sequence" CHECK ("v2"."session_turns"."sequence" > 0) NOT VALID;
