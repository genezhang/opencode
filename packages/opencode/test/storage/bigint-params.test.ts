// Regression test for zeta-embedded GH-15 — JS Number params against BIGINT
// columns that are part of a composite index key.
//
// Before the fix: napi-rs + serde encoded `Date.now() * 1000` as Float64,
// Zeta's key codec refused to build the composite key, and the DML failed
// silently (rowCount 0, no catchable exception). Every Session.create was
// returning an id whose row was never persisted.
//
// This test exercises the exact shape that blew up: session.project_id +
// session.time_created, which participates in `session_project_idx ON
// session(project_id, time_created DESC)`.
import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

test("Session.create → Session.get round-trips (BIGINT index key)", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const created = await Session.create({ title: "bigint-regression" })
      const got = await Session.get(created.id)
      expect(got.id).toBe(created.id)
      expect(got.title).toBe("bigint-regression")
    },
  })
})
