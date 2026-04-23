import { Effect, Layer, Option, Schema, ServiceMap } from "effect"

import { AccessToken, AccountID, AccountRepoError, Info, OrgID, RefreshToken } from "./schema"
import { zengramDb } from "@/storage/db.zengram"

type AccountRow = {
  id: AccountID
  email: string
  url: string
  access_token: AccessToken
  refresh_token: RefreshToken
  token_expiry: number | null
  time_created: number
  time_updated: number
}

export type { AccountRow }

const ACCOUNT_STATE_ID = 1

export namespace AccountRepo {
  export interface Service {
    readonly active: () => Effect.Effect<Option.Option<Info>, AccountRepoError>
    readonly list: () => Effect.Effect<Info[], AccountRepoError>
    readonly remove: (accountID: AccountID) => Effect.Effect<void, AccountRepoError>
    readonly use: (accountID: AccountID, orgID: Option.Option<OrgID>) => Effect.Effect<void, AccountRepoError>
    readonly getRow: (accountID: AccountID) => Effect.Effect<Option.Option<AccountRow>, AccountRepoError>
    readonly persistToken: (input: {
      accountID: AccountID
      accessToken: AccessToken
      refreshToken: RefreshToken
      expiry: Option.Option<number>
    }) => Effect.Effect<void, AccountRepoError>
    readonly persistAccount: (input: {
      id: AccountID
      email: string
      url: string
      accessToken: AccessToken
      refreshToken: RefreshToken
      expiry: number
      orgID: Option.Option<OrgID>
    }) => Effect.Effect<void, AccountRepoError>
  }
}

type AccountCols = {
  id: string
  email: string
  url: string
  access_token: string
  refresh_token: string
  token_expiry: number | null
}

export class AccountRepo extends ServiceMap.Service<AccountRepo, AccountRepo.Service>()("@opencode/AccountRepo") {
  static readonly layer: Layer.Layer<AccountRepo> = Layer.effect(
    AccountRepo,
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownSync(Info)

      const active = Effect.fn("AccountRepo.active")(() =>
        Effect.promise(async () => {
          const zdb = zengramDb()
          const stateRows = await zdb.query<{ active_account_id: string | null; active_org_id: string | null }>(
            `SELECT active_account_id, active_org_id FROM account_state WHERE id = $1`,
            [ACCOUNT_STATE_ID],
          )
          const activeId = stateRows[0]?.active_account_id
          if (!activeId) return Option.none<Info>()
          const accRows = await zdb.query<AccountCols>(
            `SELECT id, email, url, access_token, refresh_token, token_expiry FROM account WHERE id = $1`,
            [activeId],
          )
          if (!accRows[0]) return Option.none<Info>()
          return Option.some(decode({ ...accRows[0], active_org_id: stateRows[0]?.active_org_id ?? null }))
        }),
      )

      const list = Effect.fn("AccountRepo.list")(() =>
        Effect.promise(async () => {
          const rows = await zengramDb().query<AccountCols>(
            `SELECT id, email, url, access_token, refresh_token, token_expiry FROM account`,
            [],
          )
          return rows.map((row) => decode({ ...row, active_org_id: null }))
        }),
      )

      const remove = Effect.fn("AccountRepo.remove")((accountID: AccountID) =>
        Effect.promise(async () => {
          const zdb = zengramDb()
          await zdb.execute(
            `UPDATE account_state SET active_account_id = NULL, active_org_id = NULL WHERE active_account_id = $1`,
            [accountID],
          )
          await zdb.execute(`DELETE FROM account WHERE id = $1`, [accountID])
        }),
      )

      const use = Effect.fn("AccountRepo.use")((accountID: AccountID, orgID: Option.Option<OrgID>) => {
        const orgId = Option.getOrNull(orgID)
        return Effect.promise(() =>
          zengramDb().execute(
            `INSERT INTO account_state (id, active_account_id, active_org_id) VALUES ($1,$2,$3)
             ON CONFLICT (id) DO UPDATE SET active_account_id = EXCLUDED.active_account_id, active_org_id = EXCLUDED.active_org_id`,
            [ACCOUNT_STATE_ID, accountID, orgId],
          ),
        ).pipe(Effect.asVoid)
      })

      const getRow = Effect.fn("AccountRepo.getRow")((accountID: AccountID) =>
        Effect.promise(async () => {
          const rows = await zengramDb().query<AccountCols>(
            `SELECT id, email, url, access_token, refresh_token, token_expiry FROM account WHERE id = $1`,
            [accountID],
          )
          if (!rows[0]) return Option.none<AccountRow>()
          const r = rows[0]
          const row: AccountRow = {
            id: r.id as AccountID,
            email: r.email,
            url: r.url,
            access_token: r.access_token as AccessToken,
            refresh_token: r.refresh_token as RefreshToken,
            token_expiry: r.token_expiry,
            time_created: 0,
            time_updated: 0,
          }
          return Option.some(row)
        }),
      )

      const persistToken = Effect.fn("AccountRepo.persistToken")((input) =>
        Effect.promise(() =>
          zengramDb().execute(
            `UPDATE account SET access_token=$1, refresh_token=$2, token_expiry=$3 WHERE id=$4`,
            [input.accessToken, input.refreshToken, Option.getOrNull(input.expiry), input.accountID],
          ),
        ).pipe(Effect.asVoid),
      )

      const persistAccount = Effect.fn("AccountRepo.persistAccount")((input) => {
        const orgId = Option.getOrNull(input.orgID)
        return Effect.promise(async () => {
          const zdb = zengramDb()
          const now = Date.now() * 1000
          await zdb.execute(
            `INSERT INTO account (id, email, url, access_token, refresh_token, token_expiry, time_created, time_updated)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (id) DO UPDATE SET
               email = EXCLUDED.email, url = EXCLUDED.url,
               access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token,
               token_expiry = EXCLUDED.token_expiry, time_updated = EXCLUDED.time_updated`,
            [input.id, input.email, input.url, input.accessToken, input.refreshToken, input.expiry, now, now],
          )
          await zdb.execute(
            `INSERT INTO account_state (id, active_account_id, active_org_id) VALUES ($1,$2,$3)
             ON CONFLICT (id) DO UPDATE SET active_account_id = EXCLUDED.active_account_id, active_org_id = EXCLUDED.active_org_id`,
            [ACCOUNT_STATE_ID, input.id, orgId],
          )
        })
      })

      return AccountRepo.of({
        active,
        list,
        remove,
        use,
        getRow,
        persistToken,
        persistAccount,
      })
    }),
  )
}
