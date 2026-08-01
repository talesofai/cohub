import assert from "node:assert/strict";
import { test } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql as drizzleSql } from "drizzle-orm";
import { searchSessionVisibilitySql } from "./search-session-visibility.js";

const normalizeSql = (value: string) => value.replace(/\s+/g, " ").trim();
const VIEWER_USER_UUID = "viewer-user-id";

test("private Session policy blocks public Space inheritance in session and turn search", () => {
  const { sql, params } = new PgDialect().sqlToQuery(
    searchSessionVisibilitySql(VIEWER_USER_UUID),
  );

  assert.deepEqual(params, [VIEWER_USER_UUID]);
  assert.equal(
    normalizeSql(sql),
    normalizeSql(`
      (
        sp.viewer_has_member_access
        OR sess.user_uuid = $1
        OR EXISTS (
          SELECT 1
          FROM v2.access_policies session_policy
          WHERE session_policy.resource_type = 'session'
            AND session_policy.resource_id = sess.id
            AND (
              session_policy.signed_in_user_role IS NOT NULL
              OR session_policy.anonymous_user_role IS NOT NULL
            )
        )
        OR (
          NOT EXISTS (
            SELECT 1
            FROM v2.access_policies session_policy
            WHERE session_policy.resource_type = 'session'
              AND session_policy.resource_id = sess.id
          )
          AND EXISTS (
            SELECT 1
            FROM v2.access_policies space_policy
            WHERE space_policy.resource_type = 'space'
              AND space_policy.resource_id = sess.space_id
              AND (
                space_policy.signed_in_user_role IS NOT NULL
                OR space_policy.anonymous_user_role IS NOT NULL
              )
          )
        )
      )
    `),
  );
});

test(
  "public Space search excludes an explicitly private Session and its turns",
  { skip: Number(process.versions.node.split(".")[0]) < 22 },
  async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        ATTACH DATABASE ':memory:' AS v2;
        CREATE TABLE v2.spaces (
          id TEXT PRIMARY KEY,
          user_uuid TEXT NOT NULL
        );
        CREATE TABLE v2.space_members (
          space_id TEXT NOT NULL,
          user_id TEXT NOT NULL
        );
        CREATE TABLE v2.space_sessions (
          id TEXT PRIMARY KEY,
          space_id TEXT NOT NULL,
          user_uuid TEXT,
          title TEXT
        );
        CREATE TABLE v2.session_turns (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          user_text TEXT
        );
        CREATE TABLE v2.access_policies (
          resource_type TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          signed_in_user_role TEXT,
          anonymous_user_role TEXT
        );

        INSERT INTO v2.spaces (id, user_uuid) VALUES
          ('public-space', 'space-owner'),
          ('member-space', 'other-space-owner');
        INSERT INTO v2.space_members (space_id, user_id)
        VALUES ('member-space', 'viewer-user-id');
        INSERT INTO v2.access_policies (
          resource_type,
          resource_id,
          signed_in_user_role,
          anonymous_user_role
        ) VALUES ('space', 'public-space', 'guest', 'guest');

        INSERT INTO v2.space_sessions (id, space_id, user_uuid, title) VALUES
          ('private-session', 'public-space', 'session-owner', 'private needle title'),
          ('inherited-session', 'public-space', 'session-owner', 'public needle title'),
          ('owned-session', 'public-space', 'viewer-user-id', 'owner needle title'),
          ('member-session', 'member-space', 'session-owner', 'member needle title');
        INSERT INTO v2.access_policies (
          resource_type,
          resource_id,
          signed_in_user_role,
          anonymous_user_role
        ) VALUES
          ('session', 'private-session', NULL, NULL),
          ('session', 'owned-session', NULL, NULL),
          ('session', 'member-session', NULL, NULL);
        INSERT INTO v2.session_turns (id, session_id, user_text) VALUES
          ('private-turn', 'private-session', 'private needle body'),
          ('inherited-turn', 'inherited-session', 'public needle body'),
          ('owned-turn', 'owned-session', 'owner needle body'),
          ('member-turn', 'member-session', 'member needle body');
      `);

      const search = (needle: string) => {
        const query = new PgDialect().sqlToQuery(drizzleSql`
          WITH visible_spaces AS (
            SELECT
              s.*,
              (s.user_uuid = ${VIEWER_USER_UUID} OR sm.user_id IS NOT NULL) AS viewer_has_member_access
            FROM v2.spaces s
            LEFT JOIN v2.space_members sm
              ON sm.space_id = s.id AND sm.user_id = ${VIEWER_USER_UUID}
            WHERE
              s.user_uuid = ${VIEWER_USER_UUID}
              OR sm.user_id IS NOT NULL
              OR EXISTS (
                SELECT 1
                FROM v2.access_policies space_policy
                WHERE space_policy.resource_type = 'space'
                  AND space_policy.resource_id = s.id
                  AND (
                    space_policy.signed_in_user_role IS NOT NULL
                    OR space_policy.anonymous_user_role IS NOT NULL
                  )
              )
          ),
          visible_sessions AS (
            SELECT sess.*
            FROM v2.space_sessions sess
            JOIN visible_spaces sp ON sp.id = sess.space_id
            WHERE ${searchSessionVisibilitySql(VIEWER_USER_UUID)}
          ),
          session_results AS (
            SELECT 'session' AS type, sess.id
            FROM visible_sessions sess
            WHERE sess.title LIKE ${`%${needle}%`}
          ),
          turn_results AS (
            SELECT 'turn' AS type, turn.id
            FROM v2.session_turns turn
            JOIN visible_sessions sess ON sess.id = turn.session_id
            WHERE turn.user_text LIKE ${`%${needle}%`}
          )
          SELECT * FROM session_results
          UNION ALL
          SELECT * FROM turn_results
          ORDER BY type, id
        `);
        const sqliteQuery = query.sql.replace(/\$\d+/g, "?");
        const params = query.params.map((param) => {
          if (typeof param !== "string") throw new TypeError("search SQL test expected string parameters");
          return param;
        });
        return database.prepare(sqliteQuery).all(...params).map((row) => ({ ...row }));
      };

      assert.deepEqual(search("private needle"), []);
      assert.deepEqual(search("public needle"), [
        { type: "session", id: "inherited-session" },
        { type: "turn", id: "inherited-turn" },
      ]);
      assert.deepEqual(search("owner needle"), [
        { type: "session", id: "owned-session" },
        { type: "turn", id: "owned-turn" },
      ]);
      assert.deepEqual(search("member needle"), [
        { type: "session", id: "member-session" },
        { type: "turn", id: "member-turn" },
      ]);
    } finally {
      database.close();
    }
  },
);
