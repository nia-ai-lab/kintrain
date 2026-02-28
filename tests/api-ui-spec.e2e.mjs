import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminInitiateAuthCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand
} from "@aws-sdk/client-cognito-identity-provider";
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool
} from "amazon-cognito-identity-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const outputsPath = path.join(repoRoot, "frontend", "src", "amplify_outputs.json");

if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto;
}

function todayYmdUtc() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
}

function monthYmUtc() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function nowIsoSeconds() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function loadAmplifyOutputs() {
  const raw = await readFile(outputsPath, "utf-8");
  return JSON.parse(raw);
}

async function createTestUserAndToken(outputs) {
  const region = outputs.auth.aws_region;
  const userPoolId = outputs.auth.user_pool_id;
  const userPoolClientId = outputs.auth.user_pool_client_id;
  const coreApiEndpoint = String(outputs.custom?.endpoints?.coreApiEndpoint ?? "").replace(/\/+$/, "");

  if (!region || !userPoolId || !userPoolClientId || !coreApiEndpoint) {
    throw new Error("amplify_outputs.json に必要な情報が不足しています。");
  }

  const cognito = new CognitoIdentityProviderClient({ region });
  const stamp = Date.now();
  const email = `kintrain-api-test-${stamp}@example.com`;
  const password = `K1nTrain!${stamp % 1000000}Aa`;

  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }],
      MessageAction: "SUPPRESS"
    })
  );

  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: email,
      Password: password,
      Permanent: true
    })
  );

  let accessToken;
  const adminFlows = ["ADMIN_USER_PASSWORD_AUTH", "ADMIN_NO_SRP_AUTH"];
  for (const flow of adminFlows) {
    try {
      const auth = await cognito.send(
        new AdminInitiateAuthCommand({
          UserPoolId: userPoolId,
          ClientId: userPoolClientId,
          AuthFlow: flow,
          AuthParameters: {
            USERNAME: email,
            PASSWORD: password
          }
        })
      );
      accessToken = auth.AuthenticationResult?.AccessToken;
      if (accessToken) {
        break;
      }
    } catch {
      // try next flow
    }
  }

  if (!accessToken) {
    try {
      const auth = await cognito.send(
        new InitiateAuthCommand({
          ClientId: userPoolClientId,
          AuthFlow: "USER_PASSWORD_AUTH",
          AuthParameters: {
            USERNAME: email,
            PASSWORD: password
          }
        })
      );
      accessToken = auth.AuthenticationResult?.AccessToken;
    } catch {
      // handled by final check
    }
  }

  if (!accessToken) {
    accessToken = await getAccessTokenBySrp({
      userPoolId,
      userPoolClientId,
      username: email,
      password
    });
  }

  if (!accessToken) {
    throw new Error("Cognitoアクセストークン取得に失敗しました。App ClientのAuthFlow設定を確認してください。");
  }

  return {
    region,
    userPoolId,
    username: email,
    accessToken,
    coreApiEndpoint,
    cognito
  };
}

function getAccessTokenBySrp({
  userPoolId,
  userPoolClientId,
  username,
  password
}) {
  return new Promise((resolve, reject) => {
    const userPool = new CognitoUserPool({
      UserPoolId: userPoolId,
      ClientId: userPoolClientId
    });

    const user = new CognitoUser({
      Username: username,
      Pool: userPool
    });

    const authDetails = new AuthenticationDetails({
      Username: username,
      Password: password
    });

    user.authenticateUser(authDetails, {
      onSuccess: (session) => {
        resolve(session.getAccessToken().getJwtToken());
      },
      onFailure: (err) => {
        reject(err);
      },
      newPasswordRequired: () => {
        reject(new Error("newPasswordRequired challenge returned."));
      }
    });
  });
}

async function cleanupTestUser(context) {
  if (!context?.cognito || !context?.userPoolId || !context?.username) {
    return;
  }
  await context.cognito.send(
    new AdminDeleteUserCommand({
      UserPoolId: context.userPoolId,
      Username: context.username
    })
  );
}

async function apiRequest({ coreApiEndpoint, accessToken, method, pathWithQuery, body, withAuth = true }) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8"
  };
  if (withAuth) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  const res = await fetch(`${coreApiEndpoint}${pathWithQuery}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return { status: res.status, json };
}

async function run() {
  const outputs = await loadAmplifyOutputs();
  const authContext = await createTestUserAndToken(outputs);

  const results = [];
  const state = {
    menuItemA: null,
    menuItemB: null,
    visitId: null,
    date: todayYmdUtc(),
    month: monthYmUtc()
  };

  async function testCase(name, fn) {
    try {
      await fn();
      results.push({ name, ok: true });
      process.stdout.write(`PASS ${name}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ name, ok: false, message });
      process.stdout.write(`FAIL ${name}: ${message}\n`);
    }
  }

  try {
    // UI仕様: 未ログイン状態でAPIにアクセス不可
    await testCase("Auth: unauthorized request is rejected", async () => {
      const res = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "GET",
        pathWithQuery: "/me/profile",
        withAuth: false
      });
      assert.equal(res.status, 401);
    });

    // /settings
    await testCase("Settings: GET /me/profile returns default profile", async () => {
      const res = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "GET",
        pathWithQuery: "/me/profile"
      });
      assert.equal(res.status, 200);
      assert.ok(typeof res.json.userName === "string");
      assert.ok(typeof res.json.timeZoneId === "string");
    });

    await testCase("Settings: PUT /me/profile updates profile", async () => {
      const payload = {
        userName: "SpecTestUser",
        sex: "other",
        birthDate: "1993-04-05",
        heightCm: 171.2,
        timeZoneId: "Asia/Tokyo"
      };
      const putRes = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "PUT",
        pathWithQuery: "/me/profile",
        body: payload
      });
      assert.equal(putRes.status, 200);

      const getRes = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "GET",
        pathWithQuery: "/me/profile"
      });
      assert.equal(getRes.status, 200);
      assert.equal(getRes.json.userName, payload.userName);
      assert.equal(getRes.json.sex, payload.sex);
      assert.equal(getRes.json.birthDate, payload.birthDate);
      assert.equal(getRes.json.timeZoneId, payload.timeZoneId);
    });

    // /training-menu
    await testCase("TrainingMenu: POST /training-menu-items creates first item", async () => {
      const res = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "POST",
        pathWithQuery: "/training-menu-items",
        body: {
          trainingName: "チェストプレス",
          defaultWeightKg: 25.25,
          defaultRepsMin: 8,
          defaultRepsMax: 12,
          defaultSets: 3
        }
      });
      assert.equal(res.status, 201);
      assert.ok(res.json.trainingMenuItemId);
      state.menuItemA = res.json.trainingMenuItemId;
    });

    await testCase("TrainingMenu: POST /training-menu-items creates second item", async () => {
      const res = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "POST",
        pathWithQuery: "/training-menu-items",
        body: {
          trainingName: "ラットプルダウン",
          defaultWeightKg: 30,
          defaultRepsMin: 8,
          defaultRepsMax: 10,
          defaultSets: 3
        }
      });
      assert.equal(res.status, 201);
      assert.ok(res.json.trainingMenuItemId);
      state.menuItemB = res.json.trainingMenuItemId;
    });

    await testCase("TrainingMenu: GET /training-menu-items returns list", async () => {
      const res = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "GET",
        pathWithQuery: "/training-menu-items"
      });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.json.items));
      assert.ok(res.json.items.length >= 2);
    });

    await testCase("TrainingMenu: PUT /training-menu-items/{id} updates item", async () => {
      assert.ok(state.menuItemA);
      const res = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "PUT",
        pathWithQuery: `/training-menu-items/${state.menuItemA}`,
        body: {
          trainingName: "チェストプレス改",
          defaultWeightKg: 26.5,
          defaultRepsMin: 8,
          defaultRepsMax: 11,
          defaultSets: 4
        }
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.trainingName, "チェストプレス改");
    });

    await testCase("TrainingMenu: PUT /training-menu-items/reorder updates order", async () => {
      assert.ok(state.menuItemA && state.menuItemB);
      const res = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "PUT",
        pathWithQuery: "/training-menu-items/reorder",
        body: {
          items: [
            { trainingMenuItemId: state.menuItemA, displayOrder: 2 },
            { trainingMenuItemId: state.menuItemB, displayOrder: 1 }
          ]
        }
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.updatedCount, 2);
    });

    // /training-session (API)
    await testCase("TrainingSession: GET /training-session-view?date=... returns session view", async () => {
      const res = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "GET",
        pathWithQuery: `/training-session-view?date=${state.date}`
      });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.json.items));
      assert.ok(Array.isArray(res.json.todayDoneTrainingMenuItemIds));
    });

    // /gym-visits
    await testCase("TrainingSession: POST /gym-visits records a gym visit", async () => {
      const startedAt = nowIsoSeconds();
      const endedAt = new Date(Date.now() + 30 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
      const res = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "POST",
        pathWithQuery: "/gym-visits",
        body: {
          startedAtUtc: startedAt,
          endedAtUtc: endedAt,
          timeZoneId: "Asia/Tokyo",
          visitDateLocal: state.date,
          entries: [
            {
              trainingMenuItemId: state.menuItemB,
              trainingNameSnapshot: "ラットプルダウン",
              weightKg: 32.5,
              reps: 10,
              sets: 3,
              performedAtUtc: startedAt
            }
          ],
          note: "ui-spec test"
        }
      });
      assert.equal(res.status, 201);
      assert.ok(res.json.visitId);
      state.visitId = res.json.visitId;
    });

    await testCase("TrainingSession: GET /gym-visits?from&to returns visit list", async () => {
      const res = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "GET",
        pathWithQuery: `/gym-visits?from=${state.date}&to=${state.date}`
      });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.json.items));
      assert.ok(res.json.items.length >= 1);
    });

    await testCase("TrainingSession: GET /gym-visits/{visitId} returns details", async () => {
      assert.ok(state.visitId);
      const res = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "GET",
        pathWithQuery: `/gym-visits/${state.visitId}`
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.visitId, state.visitId);
      assert.ok(Array.isArray(res.json.entries));
    });

    await testCase("TrainingSession: PUT /gym-visits/{visitId} updates details", async () => {
      assert.ok(state.visitId);
      const startedAt = nowIsoSeconds();
      const endedAt = new Date(Date.now() + 20 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
      const res = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "PUT",
        pathWithQuery: `/gym-visits/${state.visitId}`,
        body: {
          startedAtUtc: startedAt,
          endedAtUtc: endedAt,
          timeZoneId: "Asia/Tokyo",
          visitDateLocal: state.date,
          entries: [
            {
              trainingMenuItemId: state.menuItemA,
              trainingNameSnapshot: "チェストプレス改",
              weightKg: 27.5,
              reps: 10,
              sets: 3,
              performedAtUtc: startedAt
            }
          ],
          note: "updated"
        }
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.note, "updated");
    });

    // /daily
    await testCase("Daily: GET /daily-records/{date} returns current record", async () => {
      const res = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "GET",
        pathWithQuery: `/daily-records/${state.date}`
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.recordDate, state.date);
    });

    await testCase("Daily: PUT /daily-records/{date} updates record", async () => {
      const res = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "PUT",
        pathWithQuery: `/daily-records/${state.date}`,
        body: {
          bodyWeightKg: 69.8,
          bodyFatPercent: 17.5,
          bodyMetricMeasuredTimeLocal: "18:45",
          bodyMetricMeasuredAtUtc: nowIsoSeconds(),
          bodyMetricMeasuredAtLocal: `${state.date}T18:45:00+09:00`,
          timeZoneId: "Asia/Tokyo",
          conditionRating: 4,
          conditionComment: "good",
          diary: "spec test diary",
          otherActivities: ["ジョギング 1km"]
        }
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.conditionRating, 4);
    });

    await testCase("Daily: GET /daily-records?from&to returns range records", async () => {
      const res = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "GET",
        pathWithQuery: `/daily-records?from=${state.date}&to=${state.date}`
      });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.json.items));
      assert.ok(res.json.items.length >= 1);
    });

    await testCase("Calendar: GET /calendar?month=YYYY-MM returns monthly marks", async () => {
      const res = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "GET",
        pathWithQuery: `/calendar?month=${state.month}`
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.month, state.month);
      assert.ok(Array.isArray(res.json.days));
    });

    // /ai-character-profile
    await testCase("AI settings: GET /ai-character-profile returns profile", async () => {
      const res = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "GET",
        pathWithQuery: "/ai-character-profile"
      });
      assert.equal(res.status, 200);
      assert.ok(typeof res.json.characterName === "string");
    });

    await testCase("AI settings: PUT /ai-character-profile updates profile", async () => {
      const payload = {
        characterId: "nyaruko",
        characterName: "ニャル子Spec",
        avatarImageUrl: "/assets/characters/nyaruko/expressions/default.png",
        tonePreset: "friendly-coach"
      };
      const putRes = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "PUT",
        pathWithQuery: "/ai-character-profile",
        body: payload
      });
      assert.equal(putRes.status, 200);

      const getRes = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "GET",
        pathWithQuery: "/ai-character-profile"
      });
      assert.equal(getRes.status, 200);
      assert.equal(getRes.json.characterName, payload.characterName);
    });

    // goals (spec-required API)
    await testCase("Goal: GET /goals returns current goal", async () => {
      const res = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "GET",
        pathWithQuery: "/goals"
      });
      assert.equal(res.status, 200);
      assert.ok(typeof res.json.targetWeightKg === "number");
      assert.ok(typeof res.json.targetBodyFatPercent === "number");
    });

    await testCase("Goal: PUT /goals updates current goal", async () => {
      const payload = {
        targetWeightKg: 68,
        targetBodyFatPercent: 15
      };
      const putRes = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "PUT",
        pathWithQuery: "/goals",
        body: payload
      });
      assert.equal(putRes.status, 200);

      const getRes = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "GET",
        pathWithQuery: "/goals"
      });
      assert.equal(getRes.status, 200);
      assert.equal(getRes.json.targetWeightKg, payload.targetWeightKg);
      assert.equal(getRes.json.targetBodyFatPercent, payload.targetBodyFatPercent);
    });

    await testCase("TrainingSession: DELETE /gym-visits/{visitId} removes visit", async () => {
      assert.ok(state.visitId);
      const deleteRes = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "DELETE",
        pathWithQuery: `/gym-visits/${state.visitId}`
      });
      assert.equal(deleteRes.status, 204);

      const getRes = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "GET",
        pathWithQuery: `/gym-visits/${state.visitId}`
      });
      assert.equal(getRes.status, 404);
    });

    await testCase("TrainingMenu: DELETE /training-menu-items/{id} deletes item", async () => {
      assert.ok(state.menuItemA && state.menuItemB);

      const resA = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "DELETE",
        pathWithQuery: `/training-menu-items/${state.menuItemA}`
      });
      const resB = await apiRequest({
        coreApiEndpoint: authContext.coreApiEndpoint,
        accessToken: authContext.accessToken,
        method: "DELETE",
        pathWithQuery: `/training-menu-items/${state.menuItemB}`
      });
      assert.equal(resA.status, 204);
      assert.equal(resB.status, 204);
    });
  } finally {
    try {
      await cleanupTestUser(authContext);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`WARN cleanup failed: ${message}\n`);
    }
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n=== API UI-Spec Test Summary ===\n`);
  process.stdout.write(`Passed: ${passed}\n`);
  process.stdout.write(`Failed: ${failed.length}\n`);
  if (failed.length > 0) {
    for (const f of failed) {
      process.stdout.write(`- ${f.name}: ${f.message}\n`);
    }
    process.exitCode = 1;
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
