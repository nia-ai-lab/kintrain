import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminInitiateAuthCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand
} from '@aws-sdk/client-cognito-identity-provider';
import { AuthenticationDetails, CognitoUser, CognitoUserPool } from 'amazon-cognito-identity-js';
import { expect, test } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const outputsPath = path.join(repoRoot, 'frontend', 'src', 'amplify_outputs.json');

if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto;
}

const state = {
  auth: null,
  seeded: null,
  todayYmd: ymdInTimeZone(new Date(), 'Asia/Tokyo')
};

function buildCoreMockData() {
  const now = isoUtcNoMillis(new Date());
  return {
    profile: {
      userName: 'UI Test User',
      sex: 'no-answer',
      birthDate: '1990-01-01',
      heightCm: 170,
      timeZoneId: 'Asia/Tokyo'
    },
    menuItems: [
      {
        trainingMenuItemId: 'm-1',
        trainingName: 'チェストプレス',
        defaultWeightKg: 25,
        defaultRepsMin: 8,
        defaultRepsMax: 12,
        defaultSets: 3,
        displayOrder: 1,
        isActive: true,
        createdAt: now,
        updatedAt: now
      },
      {
        trainingMenuItemId: 'm-2',
        trainingName: 'ラットプルダウン',
        defaultWeightKg: 30,
        defaultRepsMin: 8,
        defaultRepsMax: 10,
        defaultSets: 3,
        displayOrder: 2,
        isActive: true,
        createdAt: now,
        updatedAt: now
      },
      {
        trainingMenuItemId: 'm-3',
        trainingName: 'レッグプレス',
        defaultWeightKg: 80,
        defaultRepsMin: 10,
        defaultRepsMax: 12,
        defaultSets: 3,
        displayOrder: 3,
        isActive: true,
        createdAt: now,
        updatedAt: now
      },
      {
        trainingMenuItemId: 'm-4',
        trainingName: 'ショルダープレス',
        defaultWeightKg: 15,
        defaultRepsMin: 8,
        defaultRepsMax: 10,
        defaultSets: 3,
        displayOrder: 4,
        isActive: true,
        createdAt: now,
        updatedAt: now
      },
      {
        trainingMenuItemId: 'm-5',
        trainingName: 'シーテッドロー',
        defaultWeightKg: 27.5,
        defaultRepsMin: 10,
        defaultRepsMax: 12,
        defaultSets: 3,
        displayOrder: 5,
        isActive: true,
        createdAt: now,
        updatedAt: now
      }
    ],
    sequence: 100
  };
}

async function attachCoreApiMock(page) {
  assert.ok(state.auth, 'auth context is required');
  const mock = buildCoreMockData();
  const baseUrl = state.auth.coreApiEndpoint.replace(/\/+$/, '');
  const basePath = new URL(baseUrl).pathname.replace(/\/$/, '');

  await page.route(`${baseUrl}/**`, async (route) => {
    const req = route.request();
    const method = req.method().toUpperCase();
    const url = new URL(req.url());
    const path = url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) || '/' : url.pathname;
    const now = isoUtcNoMillis(new Date());

    const json = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(body)
      });

    if (path === '/me/profile' && method === 'GET') {
      return json(mock.profile);
    }
    if (path === '/me/profile' && method === 'PUT') {
      const next = JSON.parse(req.postData() ?? '{}');
      mock.profile = {
        ...mock.profile,
        ...next
      };
      return json(mock.profile);
    }
    if (path === '/training-menu-items' && method === 'GET') {
      const sorted = [...mock.menuItems].sort((a, b) => a.displayOrder - b.displayOrder);
      return json({ items: sorted });
    }
    if (path === '/training-menu-items' && method === 'POST') {
      const input = JSON.parse(req.postData() ?? '{}');
      const repsMin = Number(input.defaultRepsMin ?? input.defaultReps ?? 0);
      const repsMax = Number(input.defaultRepsMax ?? input.defaultReps ?? repsMin);
      const item = {
        trainingMenuItemId: `mock-${mock.sequence}`,
        trainingName: String(input.trainingName ?? '').trim(),
        defaultWeightKg: Number(input.defaultWeightKg ?? 0),
        defaultRepsMin: repsMin,
        defaultRepsMax: repsMax,
        defaultSets: Number(input.defaultSets ?? 0),
        displayOrder: mock.menuItems.length + 1,
        isActive: true,
        createdAt: now,
        updatedAt: now
      };
      mock.sequence += 1;
      mock.menuItems.push(item);
      return json(item, 201);
    }
    if (path === '/training-menu-items/reorder' && method === 'PUT') {
      const input = JSON.parse(req.postData() ?? '{}');
      const updates = Array.isArray(input.items) ? input.items : [];
      const orderMap = new Map(updates.map((u) => [u.trainingMenuItemId, Number(u.displayOrder)]));
      mock.menuItems = mock.menuItems.map((item) =>
        orderMap.has(item.trainingMenuItemId)
          ? { ...item, displayOrder: orderMap.get(item.trainingMenuItemId), updatedAt: now }
          : item
      );
      return json({ updatedCount: updates.length });
    }
    if (path.startsWith('/training-menu-items/') && method === 'PUT') {
      const itemId = path.split('/').pop();
      const patch = JSON.parse(req.postData() ?? '{}');
      const index = mock.menuItems.findIndex((item) => item.trainingMenuItemId === itemId);
      if (index < 0) {
        return json({ message: 'Not found' }, 404);
      }
      mock.menuItems[index] = {
        ...mock.menuItems[index],
        ...patch,
        updatedAt: now
      };
      return json(mock.menuItems[index]);
    }
    if (path.startsWith('/training-menu-items/') && method === 'DELETE') {
      const itemId = path.split('/').pop();
      mock.menuItems = mock.menuItems.filter((item) => item.trainingMenuItemId !== itemId);
      return route.fulfill({ status: 204, body: '' });
    }
    return json({ message: `No mock route for ${method} ${path}` }, 404);
  });
}

function ymdInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  if (!year || !month || !day) {
    throw new Error('failed to format date parts');
  }
  return `${year}-${month}-${day}`;
}

function isoUtcNoMillis(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function loadAmplifyOutputs() {
  const raw = await readFile(outputsPath, 'utf-8');
  return JSON.parse(raw);
}

async function apiRequest({ coreApiEndpoint, accessToken, method, pathWithQuery, body, withAuth = true }) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8'
  };
  if (withAuth) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const response = await fetch(`${coreApiEndpoint}${pathWithQuery}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }

  return { status: response.status, json };
}

function getAccessTokenBySrp({ userPoolId, userPoolClientId, username, password }) {
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
        reject(new Error('newPasswordRequired challenge returned.'));
      }
    });
  });
}

async function createTestUserAndToken(outputs) {
  const region = outputs.auth.aws_region;
  const userPoolId = outputs.auth.user_pool_id;
  const userPoolClientId = outputs.auth.user_pool_client_id;
  const coreApiEndpoint = String(outputs.custom?.endpoints?.coreApiEndpoint ?? '').replace(/\/+$/, '');

  if (!region || !userPoolId || !userPoolClientId || !coreApiEndpoint) {
    throw new Error('amplify_outputs.json に必要な情報が不足しています。');
  }

  const cognito = new CognitoIdentityProviderClient({ region });
  const stamp = Date.now();
  const email = `kintrain-ui-test-${stamp}@example.com`;
  const password = `K1nTrain!${stamp % 1000000}Bb`;

  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' }
      ],
      MessageAction: 'SUPPRESS'
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
  for (const flow of ['ADMIN_USER_PASSWORD_AUTH', 'ADMIN_NO_SRP_AUTH']) {
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
      // continue
    }
  }

  if (!accessToken) {
    try {
      const auth = await cognito.send(
        new InitiateAuthCommand({
          ClientId: userPoolClientId,
          AuthFlow: 'USER_PASSWORD_AUTH',
          AuthParameters: {
            USERNAME: email,
            PASSWORD: password
          }
        })
      );
      accessToken = auth.AuthenticationResult?.AccessToken;
    } catch {
      // continue
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
    throw new Error('Cognitoアクセストークン取得に失敗しました。');
  }

  return {
    region,
    userPoolId,
    userPoolClientId,
    username: email,
    password,
    coreApiEndpoint,
    accessToken,
    cognito
  };
}

async function cleanupTestUser(authContext) {
  if (!authContext?.cognito || !authContext?.userPoolId || !authContext?.username) {
    return;
  }

  await authContext.cognito.send(
    new AdminDeleteUserCommand({
      UserPoolId: authContext.userPoolId,
      Username: authContext.username
    })
  );
}

async function seedBackendData(authContext) {
  const profilePayload = {
    userName: 'UI Test User',
    sex: 'no-answer',
    birthDate: '1990-01-01',
    heightCm: 170,
    timeZoneId: 'Asia/Tokyo'
  };

  const putProfileRes = await apiRequest({
    coreApiEndpoint: authContext.coreApiEndpoint,
    accessToken: authContext.accessToken,
    method: 'PUT',
    pathWithQuery: '/me/profile',
    body: profilePayload
  });
  assert.equal(putProfileRes.status, 200);

  const menuPayloads = [
    { trainingName: 'シーテッドロー', defaultWeightKg: 27.5, defaultRepsMin: 10, defaultRepsMax: 12, defaultSets: 3 },
    { trainingName: 'チェストプレス', defaultWeightKg: 25, defaultRepsMin: 8, defaultRepsMax: 12, defaultSets: 3 },
    { trainingName: 'ラットプルダウン', defaultWeightKg: 30, defaultRepsMin: 8, defaultRepsMax: 10, defaultSets: 3 }
  ];

  const createdMenuItems = [];
  for (const payload of menuPayloads) {
    const res = await apiRequest({
      coreApiEndpoint: authContext.coreApiEndpoint,
      accessToken: authContext.accessToken,
      method: 'POST',
      pathWithQuery: '/training-menu-items',
      body: payload
    });
    assert.equal(res.status, 201);
    createdMenuItems.push(res.json);
  }

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const startedAtUtc = isoUtcNoMillis(new Date(yesterday.getTime() + 19 * 60 * 60 * 1000));
  const endedAtUtc = isoUtcNoMillis(new Date(yesterday.getTime() + 20 * 60 * 60 * 1000));
  const visitDateLocal = ymdInTimeZone(yesterday, 'Asia/Tokyo');

  const gymVisitRes = await apiRequest({
    coreApiEndpoint: authContext.coreApiEndpoint,
    accessToken: authContext.accessToken,
    method: 'POST',
    pathWithQuery: '/gym-visits',
    body: {
      startedAtUtc,
      endedAtUtc,
      timeZoneId: 'Asia/Tokyo',
      visitDateLocal,
      entries: [
        {
          trainingMenuItemId: createdMenuItems[0].trainingMenuItemId,
          trainingNameSnapshot: createdMenuItems[0].trainingName,
          weightKg: 27.5,
          reps: 12,
          sets: 3,
          performedAtUtc: startedAtUtc
        }
      ],
      note: 'ui test seed'
    }
  });
  assert.equal(gymVisitRes.status, 201);

  return {
    menuItemNames: createdMenuItems.map((item) => item.trainingName),
    seededVisitId: gymVisitRes.json.visitId
  };
}

async function login(page) {
  assert.ok(state.auth, 'auth context is required');

  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'KinTrain ログイン' })).toBeVisible();

  await page.getByLabel('メールアドレス').fill(state.auth.username);
  await page.getByLabel('パスワード').fill(state.auth.password);
  await page.getByRole('button', { name: 'ログイン' }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: '今日の状態' })).toBeVisible();
}

test.beforeAll(async () => {
  const outputs = await loadAmplifyOutputs();
  const auth = await createTestUserAndToken(outputs);
  const seeded = await seedBackendData(auth);
  state.auth = auth;
  state.seeded = seeded;
});

test.afterAll(async () => {
  if (!state.auth) {
    return;
  }
  await cleanupTestUser(state.auth);
});

test('未ログインはログイン画面へリダイレクトされ、ログイン成功でダッシュボードへ遷移する', async ({ page }) => {
  await attachCoreApiMock(page);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);

  await login(page);

  const bottomNav = page.locator('nav.bottom-nav');
  await expect(bottomNav.getByRole('link', { name: 'ホーム', exact: true })).toBeVisible();
  await expect(bottomNav.getByRole('link', { name: '実施', exact: true })).toBeVisible();
  await expect(bottomNav.getByRole('link', { name: 'カレンダー', exact: true })).toBeVisible();
  await expect(bottomNav.getByRole('link', { name: 'メニュー', exact: true })).toBeVisible();
  await expect(bottomNav.getByRole('link', { name: 'AIチャット', exact: true })).toBeVisible();
});

test('トレーニング実施画面で入力・下書き復元・前回コピー・保存ができる', async ({ page }) => {
  await attachCoreApiMock(page);
  await login(page);
  await page.goto('/training-session');

  const chestCard = page.locator('article.card').filter({ has: page.getByRole('heading', { name: 'チェストプレス' }) }).first();
  await chestCard.getByLabel('重量').fill('25.25');
  await chestCard.getByLabel('回数').fill('12');
  await chestCard.getByLabel('セット').fill('3');
  await expect(chestCard.getByLabel('重量')).toHaveValue('25.25');
  await expect(chestCard.getByLabel('回数')).toHaveValue('12');
  await expect(chestCard.getByLabel('セット')).toHaveValue('3');
  await expect(page.getByText('下書き保存中:')).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = localStorage.getItem('kintrain-mock-ui-v1');
        if (!raw) {
          return 0;
        }
        const data = JSON.parse(raw);
        const entries = Object.values(data.trainingDraft?.entriesByItemId ?? {});
        return entries.filter((entry) => (entry.weightKg ?? 0) > 0 && (entry.reps ?? 0) > 0 && (entry.sets ?? 0) > 0).length;
      })
    )
    .toBeGreaterThan(0);

  await page.getByRole('button', { name: '記録して終了' }).click();
  await expect(page).toHaveURL(new RegExp(`/daily/${state.todayYmd}$`));
  await expect(page.getByRole('heading', { name: '当日の筋トレ内容' })).toBeVisible();
  await expect(page.getByText('チェストプレス')).toBeVisible();
});

test('トレーニング実施画面で入力クリアとセット詳細の表示切替ができる', async ({ page }) => {
  await attachCoreApiMock(page);
  await login(page);
  await page.goto('/training-session');

  const chestCard = page.locator('article.card').filter({ has: page.getByRole('heading', { name: 'チェストプレス' }) }).first();
  await chestCard.getByRole('button', { name: '前回と同じ' }).click();
  await expect(chestCard.getByLabel('重量')).toHaveValue('25');
  await page.reload();
  await expect(chestCard.getByLabel('重量')).toHaveValue('25');
  await chestCard.getByRole('button', { name: '入力クリア' }).click();
  await expect(chestCard.getByLabel('重量')).toHaveValue('');

  const latCard = page.locator('article.card').filter({ has: page.getByRole('heading', { name: 'ラットプルダウン' }) }).first();
  await latCard.getByRole('button', { name: 'セット詳細を入力' }).click();
  await expect(latCard.getByText('1set')).toBeVisible();
  await latCard.getByRole('button', { name: 'セット詳細を閉じる' }).click();
  await expect(latCard.getByText('1set')).toHaveCount(0);
});

test('トレーニングメニューで追加・編集・削除・AI生成反映ができる', async ({ page }) => {
  await attachCoreApiMock(page);
  await login(page);
  await page.goto('/training-menu');

  const uniqueName = `UI追加-${Date.now()}`;
  const addSection = page.locator('section.card').filter({ has: page.getByRole('heading', { name: '新規追加' }) }).first();

  await addSection.getByLabel('トレーニング名').fill(uniqueName);
  await addSection.getByLabel('重量 (kg)').fill('22.5');
  await addSection.getByLabel('回数 最小').fill('8');
  await addSection.getByLabel('回数 最大').fill('11');
  await addSection.getByLabel('セット').fill('3');
  await addSection.getByRole('button', { name: '追加' }).click();

  const addedCard = page.locator('article.card').filter({ has: page.locator(`input[value="${uniqueName}"]`) }).first();
  await expect(addedCard).toBeVisible();

  await addedCard.getByLabel('回数 最大').fill('9');
  await expect(addedCard.getByLabel('回数 最大')).toHaveValue('9');

  await addedCard.getByRole('button', { name: '↑' }).click();
  await addedCard.getByRole('button', { name: '↓' }).click();
  await addedCard.getByRole('button', { name: '削除' }).click();
  await expect(page.locator('article.card').filter({ has: page.locator(`input[value="${uniqueName}"]`) })).toHaveCount(0);

  await page.getByRole('link', { name: 'AIでメニュー生成' }).click();
  await expect(page).toHaveURL(/\/training-menu\/ai-generate$/);
  await page.getByLabel('方針').selectOption('machine-and-free');
  await page.getByRole('button', { name: 'この提案でメニュー更新' }).click();

  await expect(page).toHaveURL(/\/training-menu$/);
  await expect(page.locator('input[value="ダンベルベンチプレス"]')).toBeVisible();
});

test('カレンダーとDailyで記録の入力・参照ができる', async ({ page }) => {
  await attachCoreApiMock(page);
  await login(page);
  await page.goto('/calendar');

  const dayNumber = Number(state.todayYmd.slice(-2));
  const todayCell = page
    .locator('button.calendar-cell')
    .filter({ has: page.locator('.day-number', { hasText: String(dayNumber) }) })
    .first();

  await todayCell.click();
  await expect(page).toHaveURL(new RegExp(`/daily/${state.todayYmd}$`));

  await page.getByLabel('体重 (kg)').fill('69.8');
  await page.getByLabel('体脂肪率 (%)').fill('17.5');
  await page.getByLabel('測定時刻').fill('07:30');
  await page.getByRole('button', { name: /良い/ }).click();
  await page.getByLabel('コメント').fill('体調はまずまず');
  await page.getByPlaceholder('今日の記録や気づき').fill('UIテストでDaily更新を確認');

  await page.getByPlaceholder('例: ジョギング 1km').fill('ジョギング 1km');
  await page.getByRole('button', { name: '追加' }).click();
  await expect(page.getByText('ジョギング 1km')).toBeVisible();

  await page.goto('/calendar');
  const todayCellAfter = page
    .locator('button.calendar-cell')
    .filter({ has: page.locator('.day-number', { hasText: String(dayNumber) }) })
    .first();
  await expect(todayCellAfter.locator('.condition-icon')).toHaveText('🙂');
});

test('AIチャットで送信とモック応答の表示ができる', async ({ page }) => {
  await attachCoreApiMock(page);
  await login(page);
  await page.goto('/ai-chat');

  const prompt = '今日はジムが混んでいます。優先順を教えて';
  await page.getByPlaceholder('例: 今日ジムが混んでいます。優先順を教えて').fill(prompt);
  await page.getByRole('button', { name: '送信' }).click();

  await expect(page.getByText(prompt)).toBeVisible();

  const lastAssistantBubble = page.locator('.message-row.assistant .message-bubble').last();
  await expect.poll(async () => (await lastAssistantBubble.textContent()) ?? '').toContain('今日の混雑前提なら');
});

test('設定保存とログアウトができる', async ({ page }) => {
  await attachCoreApiMock(page);
  await login(page);
  await page.goto('/settings');

  await page.getByLabel('ユーザ名').fill('UI設定テスト');
  await page.getByLabel('タイムゾーン').fill('Asia/Tokyo');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('ユーザ設定を保存しました。')).toBeVisible();

  await page.getByLabel('キャラクター名').fill('ニャル子');
  await page.getByRole('button', { name: 'AI設定を反映' }).click();
  await expect(page.getByText('AIコーチキャラクター設定を反映しました。')).toBeVisible();

  await page.getByRole('button', { name: 'ログアウト' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
});
