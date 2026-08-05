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
        description:
          '肩甲骨を軽く寄せて胸を張ります。\nハンドルは胸の高さに合わせ、肘を伸ばし切る直前で止めます。\n戻す動作はゆっくり行ってください。',
        muscleTargets: [
          { muscleId: 'chest_mid', role: 'primary' },
          { muscleId: 'triceps', role: 'secondary' }
        ],
        movementPattern: 'horizontal_push',
        laterality: 'bilateral',
        loadModel: 'external_load',
        classificationVersion: 1,
        equipment: 'マシン',
        weightInputMode: 'direct',
        loadMultiplier: 1,
        fixedWeightKg: 0,
        usageCount: 1,
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
        muscleTargets: [
          { muscleId: 'latissimus', role: 'primary' },
          { muscleId: 'biceps', role: 'secondary' }
        ],
        movementPattern: 'vertical_pull',
        laterality: 'bilateral',
        loadModel: 'external_load',
        classificationVersion: 1,
        equipment: 'マシン',
        weightInputMode: 'direct',
        loadMultiplier: 1,
        fixedWeightKg: 0,
        usageCount: 1,
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
        muscleTargets: [
          { muscleId: 'quadriceps', role: 'primary' },
          { muscleId: 'glute_max', role: 'secondary' }
        ],
        movementPattern: 'squat',
        laterality: 'bilateral',
        loadModel: 'external_load',
        classificationVersion: 1,
        equipment: 'マシン',
        weightInputMode: 'direct',
        loadMultiplier: 1,
        fixedWeightKg: 0,
        usageCount: 1,
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
        muscleTargets: [
          { muscleId: 'anterior_deltoid', role: 'primary' },
          { muscleId: 'triceps', role: 'secondary' }
        ],
        movementPattern: 'vertical_push',
        laterality: 'bilateral',
        loadModel: 'external_load',
        classificationVersion: 1,
        equipment: 'マシン',
        weightInputMode: 'direct',
        loadMultiplier: 1,
        fixedWeightKg: 0,
        usageCount: 1,
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
        muscleTargets: [
          { muscleId: 'upper_back', role: 'primary' },
          { muscleId: 'biceps', role: 'secondary' }
        ],
        movementPattern: 'horizontal_pull',
        laterality: 'bilateral',
        loadModel: 'external_load',
        classificationVersion: 1,
        equipment: 'マシン',
        weightInputMode: 'direct',
        loadMultiplier: 1,
        fixedWeightKg: 0,
        usageCount: 1,
        defaultWeightKg: 27.5,
        defaultRepsMin: 10,
        defaultRepsMax: 12,
        defaultSets: 3,
        displayOrder: 5,
        isActive: true,
        createdAt: now,
        updatedAt: now
      },
      {
        trainingMenuItemId: 'r-1',
        trainingName: '完全休養',
        itemKind: 'recovery',
        isSystemProvided: true,
        description: '',
        usageCount: 1,
        displayOrder: 6,
        isActive: true,
        createdAt: now,
        updatedAt: now
      }
    ],
    menuSets: [
      {
        trainingMenuSetId: 'set-1',
        setName: 'メインメニュー',
        menuSetOrder: 1,
        isDefault: true,
        setType: 'reusable',
        source: 'manual',
        isActive: true,
        items: [
          ['m-1', 25, 8, 12, 3],
          ['m-2', 30, 8, 10, 3],
          ['m-3', 80, 10, 12, 3],
          ['m-4', 15, 8, 10, 3],
          ['m-5', 27.5, 10, 12, 3]
        ].map(([trainingMenuItemId, targetWeightKg, targetRepsMin, targetRepsMax, targetSets], index) => ({
          trainingMenuSetItemId: `set-item-${index + 1}`,
          trainingMenuSetId: 'set-1',
          trainingMenuItemId,
          displayOrder: index + 1,
          targetWeightKg,
          targetRepsMin,
          targetRepsMax,
          targetSets,
          recommendedIntervalDays: 3,
          instruction: '',
          createdBy: 'manual'
        })),
        createdAt: now,
        updatedAt: now
      },
      {
        trainingMenuSetId: 'recovery-set-1',
        setName: 'リカバリー日',
        menuSetOrder: 2,
        isDefault: false,
        setType: 'reusable',
        source: 'manual',
        menuSetKind: 'recovery',
        isActive: true,
        items: [{
          trainingMenuSetItemId: 'recovery-set-item-1',
          trainingMenuSetId: 'recovery-set-1',
          trainingMenuItemId: 'r-1',
          displayOrder: 1,
          instruction: '運動をせず、睡眠を優先する',
          createdBy: 'manual'
        }],
        createdAt: now,
        updatedAt: now
      }
    ],
    dailyRecords: [
      {
        recordDate: state.todayYmd,
        timeZoneId: 'Asia/Tokyo',
        bodyWeightKg: 69.8,
        bodyFatPercent: 17.5,
        muscleMassKg: 52.1,
        bodyMetricMeasuredTimeLocal: '07:30',
        conditionRating: 7,
        moodRating: 8,
        conditionComment: '体調はまずまず',
        mealNotes: '朝：卵とヨーグルト',
        diary: 'UIテストの日記',
        otherActivities: [],
        createdAt: now,
        updatedAt: now
      }
    ],
    gymVisits: [
      {
        visitId: 'visit-export-1',
        startedAtUtc: `${state.todayYmd}T09:00:00Z`,
        endedAtUtc: `${state.todayYmd}T10:00:00Z`,
        timeZoneId: 'Asia/Tokyo',
        visitDateLocal: state.todayYmd,
        entries: [
          {
            trainingMenuItemId: 'm-1',
            trainingNameSnapshot: 'チェストプレス',
            muscleTargetsSnapshot: [
              { muscleId: 'chest_mid', role: 'primary' },
              { muscleId: 'triceps', role: 'secondary' }
            ],
            movementPatternSnapshot: 'horizontal_push',
            lateralitySnapshot: 'bilateral',
            loadModelSnapshot: 'external_load',
            classificationVersionSnapshot: 1,
            equipmentSnapshot: 'マシン',
            weightKg: 25,
            reps: 12,
            sets: 3,
            performedAtUtc: `${state.todayYmd}T10:00:00Z`
          }
        ],
        note: 'エクスポート確認',
        createdAt: now,
        updatedAt: now
      }
    ],
    coaching: {
      context: {
        goalSummary: '筋力を維持しながら体脂肪率を下げる',
        constraints: ['平日は60分以内'],
        preferences: ['フリーウェイトを優先'],
        trainingPolicy: 'フォームを崩さず完遂できる重量を優先する',
        nextReviewDate: state.todayYmd,
        version: 1,
        updatedAt: now,
        updatedBySource: 'user',
        changeReason: '初期設定'
      },
      notes: [],
      revisions: [
        {
          revisionId: 'revision-1',
          goalSummary: '筋力を維持しながら体脂肪率を下げる',
          constraints: ['平日は60分以内'],
          preferences: ['フリーウェイトを優先'],
          trainingPolicy: 'フォームを崩さず完遂できる重量を優先する',
          nextReviewDate: state.todayYmd,
          version: 1,
          updatedAt: now,
          updatedBySource: 'user',
          source: 'user',
          changeReason: '初期設定',
          createdAt: now
        }
      ],
      limits: {
        activeNotes: 50,
        returnedToAi: 10,
        noteRetentionDays: 90,
        revisions: 50,
        revisionRetentionDays: 365
      }
    },
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
    if (path === '/gym-visits' && method === 'GET') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const items = from && to
        ? mock.gymVisits.filter((visit) => visit.visitDateLocal >= from && visit.visitDateLocal <= to)
        : mock.gymVisits;
      return json({ items, nextToken: null });
    }
    if (path === '/menu-executions' && method === 'GET') {
      return json({ items: [], nextToken: null });
    }
    if (path === '/daily-records' && method === 'GET') {
      return json({ items: mock.dailyRecords, nextToken: null });
    }
    if (path === '/calendar' && method === 'GET') {
      return json({
        month: url.searchParams.get('month'),
        days: mock.dailyRecords.map((item) => ({
          date: item.recordDate,
          trained: mock.gymVisits.some((visit) => visit.visitDateLocal === item.recordDate),
          conditionRating: item.conditionRating ?? null,
          moodRating: item.moodRating ?? null
        }))
      });
    }
    if (path.startsWith('/daily-records/') && method === 'GET') {
      const date = path.split('/').pop();
      return json(
        mock.dailyRecords.find((item) => item.recordDate === date) ?? {
          recordDate: date,
          timeZoneId: 'Asia/Tokyo',
          otherActivities: []
        }
      );
    }
    if (path.startsWith('/daily-records/') && method === 'PUT') {
      const date = path.split('/').pop();
      const next = JSON.parse(req.postData() ?? '{}');
      const existingIndex = mock.dailyRecords.findIndex((item) => item.recordDate === date);
      const record = {
        ...(existingIndex >= 0 ? mock.dailyRecords[existingIndex] : {}),
        ...next,
        recordDate: date,
        createdAt: existingIndex >= 0 ? mock.dailyRecords[existingIndex].createdAt : now,
        updatedAt: now
      };
      for (const field of ['bodyWeightKg', 'bodyFatPercent', 'muscleMassKg', 'bodyMetricMeasuredTimeLocal']) {
        if (next[field] === null) delete record[field];
      }
      if (existingIndex >= 0) {
        mock.dailyRecords[existingIndex] = record;
      } else {
        mock.dailyRecords.push(record);
      }
      return json(record);
    }
    if (path === '/ai-character-profile' && method === 'GET') {
      return json({
        characterId: 'default',
        characterName: 'AIコーチ',
        tonePreset: 'friendly-coach',
        characterDescription: '',
        speechEnding: ''
      });
    }
    if (path === '/ai-character-profile' && method === 'PUT') {
      const next = JSON.parse(req.postData() ?? '{}');
      return json({
        characterId: 'default',
        avatarImageUrl: '/assets/characters/default.png',
        ...next,
        updatedAt: now
      });
    }
    if (path === '/coaching-context' && method === 'GET') {
      return json(mock.coaching);
    }
    if (path === '/coaching-context' && method === 'PUT') {
      const next = JSON.parse(req.postData() ?? '{}');
      const version = mock.coaching.context.version + 1;
      mock.coaching.context = {
        goalSummary: next.goalSummary,
        constraints: next.constraints,
        preferences: next.preferences,
        trainingPolicy: next.trainingPolicy,
        ...(next.nextReviewDate ? { nextReviewDate: next.nextReviewDate } : {}),
        version,
        updatedAt: now,
        updatedBySource: 'user',
        changeReason: next.changeReason
      };
      mock.coaching.revisions.unshift({
        revisionId: `revision-${version}`,
        ...mock.coaching.context,
        source: 'user',
        createdAt: now
      });
      return json(mock.coaching.context);
    }
    if (path === '/coaching-notes' && method === 'POST') {
      const next = JSON.parse(req.postData() ?? '{}');
      const note = {
        noteId: `000000000000000000000000000000${mock.sequence++}`.slice(-32),
        category: next.category,
        content: next.content,
        ...(next.validFromDate ? { validFromDate: next.validFromDate } : {}),
        ...(next.validToDate ? { validToDate: next.validToDate } : {}),
        source: 'user',
        createdAt: now,
        expiresAt: isoUtcNoMillis(new Date(Date.now() + 90 * 24 * 60 * 60 * 1000))
      };
      mock.coaching.notes.unshift(note);
      return json({ note, created: true }, 201);
    }
    if (path.startsWith('/coaching-notes/') && method === 'DELETE') {
      const noteId = path.split('/').pop();
      mock.coaching.notes = mock.coaching.notes.filter((note) => note.noteId !== noteId);
      return route.fulfill({ status: 204, body: '' });
    }
    if (path === '/goals' && method === 'GET') {
      return json({});
    }
    if (path === '/training-menu-items' && method === 'GET') {
      const sorted = [...mock.menuItems].sort((a, b) => a.displayOrder - b.displayOrder);
      return json({ items: sorted, nextToken: null });
    }
    if (path === '/training-menu-sets' && method === 'GET') {
      return json({ items: mock.menuSets });
    }
    if (path === '/training-menu-sets/set-1/items' && method === 'POST') {
      const input = JSON.parse(req.postData() ?? '{}');
      const itemId = String(input.trainingMenuItemId ?? '');
      if (itemId && !mock.menuSets[0].items.some((item) => item.trainingMenuItemId === itemId)) {
        mock.menuSets[0].items.push({
          trainingMenuSetItemId: `set-item-${mock.sequence++}`,
          trainingMenuSetId: 'set-1',
          trainingMenuItemId: itemId,
          displayOrder: mock.menuSets[0].items.length + 1,
          targetWeightKg: Number(input.targetWeightKg),
          targetRepsMin: Number(input.targetRepsMin),
          targetRepsMax: Number(input.targetRepsMax),
          targetSets: Number(input.targetSets),
          recommendedIntervalDays: Number(input.recommendedIntervalDays),
          instruction: input.instruction ?? '',
          createdBy: 'manual'
        });
      }
      return json(mock.menuSets[0].items.at(-1), 201);
    }
    if (path === '/training-menu-sets/set-1' && method === 'PUT') {
      const input = JSON.parse(req.postData() ?? '{}');
      mock.menuSets[0] = { ...mock.menuSets[0], ...input, updatedAt: now };
      return json(mock.menuSets[0]);
    }
    if (path === '/training-menu-sets/set-1/items/reorder' && method === 'PUT') {
      const input = JSON.parse(req.postData() ?? '{}');
      const order = new Map(input.items.map((item) => [item.trainingMenuSetItemId, item.displayOrder]));
      mock.menuSets[0].items = mock.menuSets[0].items
        .map((item) => ({ ...item, displayOrder: order.get(item.trainingMenuSetItemId) ?? item.displayOrder }))
        .sort((a, b) => a.displayOrder - b.displayOrder);
      return json({ updatedCount: input.items.length });
    }
    if (path.startsWith('/training-menu-sets/set-1/items/') && method === 'PUT') {
      const setItemId = path.split('/').pop();
      const input = JSON.parse(req.postData() ?? '{}');
      const index = mock.menuSets[0].items.findIndex((item) => item.trainingMenuSetItemId === setItemId);
      mock.menuSets[0].items[index] = { ...mock.menuSets[0].items[index], ...input, updatedAt: now };
      return json(mock.menuSets[0].items[index]);
    }
    if (path.startsWith('/training-menu-sets/set-1/items/') && method === 'DELETE') {
      const setItemId = path.split('/').pop();
      mock.menuSets[0].items = mock.menuSets[0].items.filter((item) => item.trainingMenuSetItemId !== setItemId);
      return route.fulfill({ status: 204, body: '' });
    }
    if (path.startsWith('/daily-training-plans/') && method === 'GET') {
      return json({ message: 'daily training plan not found.' }, 404);
    }
    if (path.startsWith('/daily-training-plans/') && method === 'PUT') {
      const input = JSON.parse(req.postData() ?? '{}');
      return json({
        planDate: path.split('/').pop(),
        trainingMenuSetId: input.trainingMenuSetId,
        source: input.source ?? 'manual',
        createdAt: now,
        updatedAt: now
      }, 201);
    }
    if (path === '/training-session-view' && method === 'GET') {
      const requestedSetId = url.searchParams.get('trainingMenuSetId');
      const requestedDate = url.searchParams.get('date') ?? state.todayYmd;
      const set = mock.menuSets.find((entry) => entry.trainingMenuSetId === requestedSetId) ?? mock.menuSets[0];
      const sorted = set.items.map((setItem, index) => ({
        ...mock.menuItems.find((item) => item.trainingMenuItemId === setItem.trainingMenuItemId),
        ...setItem,
        ...(set.menuSetKind !== 'recovery' && index === 0 && state.todayYmd <= requestedDate
          ? {
              lastPerformanceSnapshot: {
                performedAtUtc: `${state.todayYmd}T10:00:00Z`,
                weightKg: 25,
                reps: 12,
                sets: 3,
                visitDateLocal: state.todayYmd
              }
            }
          : {})
      }));
      return json({
        resolvedMenuSet: {
          trainingMenuSetId: set.trainingMenuSetId,
          setName: set.setName,
          setType: set.setType,
          source: set.source,
          isDefault: set.isDefault,
          menuSetKind: set.menuSetKind ?? 'training'
        },
        menuSetKind: set.menuSetKind ?? 'training',
        resolvedFromDailyPlan: false,
        items: sorted,
        todayDoneTrainingMenuItemIds: []
      });
    }
    if (path === '/gym-visits' && method === 'POST') {
      const input = JSON.parse(req.postData() ?? '{}');
      const created = {
        ...input,
        visitId: `visit-${mock.sequence++}`,
        createdAt: now,
        updatedAt: now
      };
      mock.gymVisits.push(created);
      return json(created, 201);
    }
    if (path === '/menu-executions' && method === 'POST') {
      const input = JSON.parse(req.postData() ?? '{}');
      return json({
        ...input,
        executionId: `execution-${mock.sequence++}`,
        createdAt: now,
        updatedAt: now
      }, 201);
    }
    if (path === '/training-menu-items' && method === 'POST') {
      const input = JSON.parse(req.postData() ?? '{}');
      const repsMin = Number(input.defaultRepsMin ?? input.defaultReps ?? 0);
      const repsMax = Number(input.defaultRepsMax ?? input.defaultReps ?? repsMin);
      const item = {
        trainingMenuItemId: `mock-${mock.sequence}`,
        trainingName: String(input.trainingName ?? '').trim(),
        exerciseFamilyId: input.exerciseFamilyId ?? input.trainingName,
        muscleTargets: Array.isArray(input.muscleTargets) ? input.muscleTargets : [],
        movementFamily: input.movementFamily ?? 'isolation',
        jointActions: input.jointActions ?? [],
        laterality: input.laterality ?? 'bilateral',
        loadModel: input.loadModel ?? 'external_load',
        classificationVersion: Number(input.classificationVersion ?? 2),
        equipmentType: input.equipmentType ?? 'other',
        equipmentProfileId: input.equipmentProfileId,
        cableSettings: input.cableSettings,
        description: String(input.description ?? '').trim(),
        weightInputMode: input.weightInputMode ?? 'direct',
        loadMultiplier: Number(input.loadMultiplier ?? 1),
        fixedWeightKg: Number(input.fixedWeightKg ?? 0),
        usageCount: 0,
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

function addYmdDays(value, days) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
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
    {
      trainingName: 'シーテッドロー',
      exerciseFamilyId: 'seated_row',
      muscleTargets: [
        { muscleId: 'latissimus', role: 'primary', effectiveSetFactor: 1 },
        { muscleId: 'biceps', role: 'secondary', effectiveSetFactor: 0.5 }
      ],
      movementFamily: 'pull',
      jointActions: ['shoulder_horizontal_abduction', 'elbow_flexion'],
      laterality: 'bilateral',
      loadModel: 'external_load',
      classificationVersion: 2,
      equipmentType: 'selectorized_machine',
      weightInputMode: 'direct',
      loadMultiplier: 1
    },
    {
      trainingName: 'チェストプレス',
      exerciseFamilyId: 'chest_press',
      muscleTargets: [
        { muscleId: 'chest_mid', role: 'primary', effectiveSetFactor: 1 },
        { muscleId: 'triceps', role: 'secondary', effectiveSetFactor: 0.5 }
      ],
      movementFamily: 'push',
      jointActions: ['shoulder_horizontal_adduction', 'elbow_extension'],
      laterality: 'bilateral',
      loadModel: 'external_load',
      classificationVersion: 2,
      equipmentType: 'selectorized_machine',
      weightInputMode: 'direct',
      loadMultiplier: 1
    },
    {
      trainingName: 'ラットプルダウン',
      exerciseFamilyId: 'lat_pulldown',
      muscleTargets: [
        { muscleId: 'latissimus', role: 'primary', effectiveSetFactor: 1 },
        { muscleId: 'biceps', role: 'secondary', effectiveSetFactor: 0.5 }
      ],
      movementFamily: 'pull',
      jointActions: ['shoulder_adduction', 'elbow_flexion'],
      laterality: 'bilateral',
      loadModel: 'external_load',
      classificationVersion: 2,
      equipmentType: 'selectorized_machine',
      weightInputMode: 'direct',
      loadMultiplier: 1
    }
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
  const visitDateLocal = ymdInTimeZone(yesterday, 'Asia/Tokyo');
  const startedAtUtc = isoUtcNoMillis(new Date(`${visitDateLocal}T19:00:00+09:00`));
  const endedAtUtc = isoUtcNoMillis(new Date(`${visitDateLocal}T20:00:00+09:00`));

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
          muscleTargetsSnapshot: createdMenuItems[0].muscleTargets,
          movementFamilySnapshot: createdMenuItems[0].movementFamily,
          jointActionsSnapshot: createdMenuItems[0].jointActions,
          lateralitySnapshot: createdMenuItems[0].laterality,
          loadModelSnapshot: createdMenuItems[0].loadModel,
          classificationVersionSnapshot: createdMenuItems[0].classificationVersion,
          equipmentTypeSnapshot: createdMenuItems[0].equipmentType,
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
  const description = chestCard.locator('details.training-description');
  await expect(description).toBeVisible();
  await expect(description).not.toHaveAttribute('open', '');
  await expect(chestCard.getByLabel('メモ')).toHaveValue('');
  await description.getByText('説明', { exact: true }).click();
  await expect(description).toHaveAttribute('open', '');
  await expect(description.locator('p')).toContainText('肩甲骨を軽く寄せて胸を張ります。');
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
        const raw = localStorage.getItem('kintrain-mock-ui-v2');
        if (!raw) {
          return 0;
        }
        const data = JSON.parse(raw);
        const entries = Object.values(data.trainingDraft?.entriesByItemId ?? {});
        return entries.filter(
          (entry) =>
            typeof entry.weightKg === 'number' &&
            Number.isFinite(entry.weightKg) &&
            entry.weightKg >= 0 &&
            (entry.reps ?? 0) > 0 &&
            (entry.sets ?? 0) > 0
        ).length;
      })
    )
    .toBeGreaterThan(0);

  await page.getByRole('button', { name: '記録して終了' }).click();
  await page.getByRole('button', { name: 'この内容で記録' }).click();
  await expect(page).toHaveURL(new RegExp(`/daily/${state.todayYmd}$`));
  await expect(page.getByRole('heading', { name: '当日の筋トレ内容' })).toBeVisible();
});

test('過去日のDailyから対象日を引き継ぎ、筋トレ実績をその日付で追加できる', async ({ page }) => {
  await attachCoreApiMock(page);
  await login(page);
  const targetDate = addYmdDays(state.todayYmd, -1);
  const displayDate = targetDate.replaceAll('-', '/');

  await page.goto(`/daily/${targetDate}`);
  await page.getByRole('link', { name: '実施を登録' }).click();

  await expect(page).toHaveURL(new RegExp(`/training-session\\?date=${targetDate}$`));
  await expect(page.getByLabel('実施日', { exact: true })).toHaveValue(targetDate);
  await expect(page.getByText('過去日の記録', { exact: true })).toBeVisible();
  await expect(page.getByText(`${displayDate} の実績として保存します。`, { exact: true })).toBeVisible();

  const chestCard = page.locator('article.card').filter({ has: page.getByRole('heading', { name: 'チェストプレス' }) }).first();
  await chestCard.getByRole('button', { name: '設定値を入力' }).click();
  await page.getByRole('button', { name: `${displayDate} として記録を確認` }).click();

  const dialog = page.getByRole('dialog', { name: '記録内容の確認' });
  await expect(dialog.getByText(displayDate, { exact: true })).toBeVisible();
  await expect(dialog.getByText('過去日の記録として保存します。', { exact: true })).toBeVisible();
  const requestPromise = page.waitForRequest((request) =>
    request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/gym-visits')
  );
  await dialog.getByRole('button', { name: 'この日付で記録' }).click();
  const request = await requestPromise;
  const input = request.postDataJSON();

  assert.equal(input.visitDateLocal, targetDate);
  assert.equal(ymdInTimeZone(new Date(input.startedAtUtc), input.timeZoneId), targetDate);
  assert.equal(ymdInTimeZone(new Date(input.endedAtUtc), input.timeZoneId), targetDate);
  assert.equal(ymdInTimeZone(new Date(input.entries[0].performedAtUtc), input.timeZoneId), targetDate);
  await expect(page).toHaveURL(new RegExp(`/daily/${targetDate}$`));
  await expect(page.getByText('チェストプレス', { exact: false }).first()).toBeVisible();
});

test('未来日の実施登録URLは本日に戻して記録を防ぐ', async ({ page }) => {
  await attachCoreApiMock(page);
  await login(page);
  const futureDate = addYmdDays(state.todayYmd, 1);

  await page.goto(`/training-session?date=${futureDate}`);

  await expect(page.getByLabel('実施日', { exact: true })).toHaveValue(state.todayYmd);
  await expect(page.getByText('未来日または不正な日付は指定できないため、本日を表示しています。')).toBeVisible();
});

test('記録内容の確認画面で種目を除外・復元し、残した種目だけを保存できる', async ({ page }) => {
  await attachCoreApiMock(page);
  await login(page);
  await page.goto('/training-session');

  const chestCard = page.locator('article.card').filter({ has: page.getByRole('heading', { name: 'チェストプレス' }) }).first();
  const latCard = page.locator('article.card').filter({ has: page.getByRole('heading', { name: 'ラットプルダウン' }) }).first();
  await chestCard.getByRole('button', { name: '設定値を入力' }).click();
  await latCard.getByRole('button', { name: '設定値を入力' }).click();

  await page.getByRole('button', { name: '記録して終了' }).click();
  const dialog = page.getByRole('dialog', { name: '記録内容の確認' });
  await dialog.getByRole('button', { name: 'チェストプレスを今回の記録から除外' }).click();
  await expect(dialog.getByRole('button', { name: 'チェストプレスを元に戻す' })).toBeVisible();
  await dialog.getByRole('button', { name: 'チェストプレスを元に戻す' }).click();
  await expect(dialog.getByRole('button', { name: 'チェストプレスを今回の記録から除外' })).toBeVisible();

  await dialog.getByRole('button', { name: 'チェストプレスを今回の記録から除外' }).click();
  await dialog.getByRole('button', { name: 'キャンセル' }).click();
  await expect(chestCard.getByLabel('重量')).toHaveValue('');
  await expect(latCard.getByLabel('重量')).toHaveValue('30');

  await page.getByRole('button', { name: '記録して終了' }).click();
  const gymVisitRequestPromise = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/gym-visits')
  );
  await page.getByRole('button', { name: 'この内容で記録' }).click();
  const gymVisitRequest = await gymVisitRequestPromise;
  const payload = gymVisitRequest.postDataJSON();
  assert.equal(payload.entries.length, 1);
  assert.equal(payload.entries[0].trainingNameSnapshot, 'ラットプルダウン');
  await expect(page).toHaveURL(new RegExp(`/daily/${state.todayYmd}$`));
});

test('確認画面ですべての記録対象を除外すると保存できず、入力途中の内容は保存対象外と表示する', async ({ page }) => {
  await attachCoreApiMock(page);
  await login(page);
  await page.goto('/training-session');

  const chestCard = page.locator('article.card').filter({ has: page.getByRole('heading', { name: 'チェストプレス' }) }).first();
  const latCard = page.locator('article.card').filter({ has: page.getByRole('heading', { name: 'ラットプルダウン' }) }).first();
  await chestCard.getByRole('button', { name: '設定値を入力' }).click();
  await latCard.getByLabel('重量').fill('30');

  await page.getByRole('button', { name: '記録して終了' }).click();
  const dialog = page.getByRole('dialog', { name: '記録内容の確認' });
  await expect(dialog.getByText('以下は入力途中のため、今回の保存対象には含まれません。')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'ラットプルダウンの入力を破棄' })).toHaveCount(0);

  await dialog.getByRole('button', { name: 'チェストプレスを今回の記録から除外' }).click();
  await expect(dialog.getByText('保存対象がありません。重量・回数・セットを入力してから記録してください。')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'この内容で記録' })).toBeDisabled();

  await dialog.getByRole('button', { name: 'チェストプレスを元に戻す' }).click();
  await expect(dialog.getByRole('button', { name: 'この内容で記録' })).toBeEnabled();
});

test('トレーニング実施画面で入力を消すことができ、セット詳細入力を表示しない', async ({ page }) => {
  await attachCoreApiMock(page);
  await login(page);
  await page.goto('/training-session');

  const chestCard = page.locator('article.card').filter({ has: page.getByRole('heading', { name: 'チェストプレス' }) }).first();
  await chestCard.getByRole('button', { name: '前回値を入力' }).click();
  await expect(chestCard.getByLabel('重量')).toHaveValue('25');
  await page.reload();
  await expect(chestCard.getByLabel('重量')).toHaveValue('25');
  await chestCard.getByRole('button', { name: '入力を消す' }).click();
  await expect(chestCard.getByLabel('重量')).toHaveValue('');

  await expect(page.getByRole('button', { name: 'セット詳細を入力' })).toHaveCount(0);
  await expect(page.locator('.set-detail-list')).toHaveCount(0);
});

test('iPhone幅の実施画面で操作ボタンと主要入力欄がそれぞれ一行に収まる', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await attachCoreApiMock(page);
  await login(page);
  await page.goto('/training-session');

  await expect(page.getByText('メニューセットの設定', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '設定値を入力' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '前回値を入力' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '入力を消す' }).first()).toBeVisible();
  const chestCard = page.locator('article.card').filter({ has: page.getByRole('heading', { name: 'チェストプレス' }) }).first();
  const actionBoxes = await Promise.all([
    chestCard.getByRole('button', { name: '設定値を入力' }).boundingBox(),
    chestCard.getByRole('button', { name: '前回値を入力' }).boundingBox(),
    chestCard.getByRole('button', { name: '入力を消す' }).boundingBox()
  ]);
  const metricBoxes = await Promise.all([
    chestCard.getByLabel('重量').boundingBox(),
    chestCard.getByLabel('回数').boundingBox(),
    chestCard.getByLabel('セット').boundingBox()
  ]);
  assert.equal(actionBoxes.every((box) => box !== null), true);
  assert.equal(metricBoxes.every((box) => box !== null), true);
  assert.equal(new Set(actionBoxes.map((box) => Math.round(box.y))).size, 1);
  assert.equal(new Set(metricBoxes.map((box) => Math.round(box.y))).size, 1);
  await chestCard.getByRole('button', { name: '設定値を入力' }).click();
  await page.getByRole('button', { name: '記録して終了' }).click();
  const dialog = page.getByRole('dialog', { name: '記録内容の確認' });
  await expect(dialog.getByRole('button', { name: 'チェストプレスを今回の記録から除外' })).toBeVisible();
  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  assert.equal(hasHorizontalOverflow, false);
  const dialogHasHorizontalOverflow = await dialog.evaluate(
    (element) => element.scrollWidth > element.clientWidth
  );
  assert.equal(dialogHasHorizontalOverflow, false);
});

test('同じ実施画面から完全休養を時間入力なしで登録できる', async ({ page }) => {
  await attachCoreApiMock(page);
  await login(page);
  await page.goto('/training-session');

  await page.getByLabel('この日のメニュー').selectOption('recovery-set-1');
  await expect(page.getByText('完全休養', { exact: true })).toBeVisible();
  await expect(page.getByLabel('重量')).toHaveCount(0);
  await page.getByRole('checkbox', { name: '完全休養' }).check();
  await page.getByRole('button', { name: '記録内容を確認' }).click();

  const dialog = page.getByRole('dialog', { name: '記録内容の確認' });
  await expect(dialog.getByText('実施: リカバリー日（リカバリー）')).toBeVisible();
  await expect(dialog.getByText('予定外')).toBeVisible();
  const requestPromise = page.waitForRequest((request) =>
    request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/menu-executions')
  );
  await dialog.getByRole('button', { name: 'この内容で記録' }).click();
  const request = await requestPromise;
  const input = request.postDataJSON();
  assert.equal(input.menuSetKind, 'recovery');
  assert.equal(input.entries[0].activityNameSnapshot, '完全休養');
  assert.equal('weightKg' in input.entries[0], false);
  assert.equal('actualDurationMinutes' in input.entries[0], false);
});

test('リカバリーは入力すると自動選択され、未選択時にも案内を表示する', async ({ page }) => {
  await attachCoreApiMock(page);
  await login(page);
  const targetDate = addYmdDays(state.todayYmd, -1);
  const displayDate = targetDate.replaceAll('-', '/');
  await page.goto(`/training-session?date=${targetDate}`);

  await page.getByLabel('この日のメニュー').selectOption('recovery-set-1');
  const recoveryCheckbox = page.getByRole('checkbox', { name: '完全休養' });
  await expect(recoveryCheckbox).not.toBeChecked();

  await page.getByRole('button', { name: `${displayDate} として記録を確認` }).click();
  await expect(page.getByText('記録するリカバリーを選択してください。チェックを入れるか、実施時間・メモを入力してください。')).toBeVisible();

  await page.getByLabel('実施時間（分・任意）').fill('15');
  await expect(recoveryCheckbox).toBeChecked();
  await page.getByRole('button', { name: `${displayDate} として記録を確認` }).click();
  await expect(page.getByRole('dialog', { name: '記録内容の確認' })).toBeVisible();
});

test('リカバリー実績も選択した過去日で登録できる', async ({ page }) => {
  await attachCoreApiMock(page);
  await login(page);
  const targetDate = addYmdDays(state.todayYmd, -1);
  const displayDate = targetDate.replaceAll('-', '/');
  await page.goto(`/training-session?date=${targetDate}`);

  await page.getByLabel('この日のメニュー').selectOption('recovery-set-1');
  await page.getByRole('checkbox', { name: '完全休養' }).check();
  await page.getByRole('button', { name: `${displayDate} として記録を確認` }).click();

  const dialog = page.getByRole('dialog', { name: '記録内容の確認' });
  await expect(dialog.getByText(displayDate, { exact: true })).toBeVisible();
  const requestPromise = page.waitForRequest((request) =>
    request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/menu-executions')
  );
  await dialog.getByRole('button', { name: 'この日付で記録' }).click();
  const input = (await requestPromise).postDataJSON();

  assert.equal(input.executionDateLocal, targetDate);
  assert.equal(ymdInTimeZone(new Date(input.entries[0].performedAtUtc), input.timeZoneId), targetDate);
  await expect(page).toHaveURL(new RegExp(`/daily/${targetDate}$`));
});

test('トレーニングメニューで追加・編集・削除ができる', async ({ page }) => {
  await attachCoreApiMock(page);
  await login(page);
  await page.goto('/training-menu');

  await expect(page.getByRole('link', { name: 'AIで一時メニューを作る' })).toBeVisible();
  await expect(page.locator('.menu-set-create-panel option[value="temporary"]')).toHaveText('一時セット');
  await expect(page.getByPlaceholder('例: 胸の日 / 回復メニュー')).toBeVisible();
  await expect(page.getByText('今日の一時セット', { exact: true })).toHaveCount(0);

  const useDate = '2026-08-03';
  await page.getByLabel('利用日').fill(useDate);
  const assignRequest = page.waitForRequest((request) =>
    request.method() === 'PUT' && new URL(request.url()).pathname.endsWith(`/daily-training-plans/${useDate}`)
  );
  await page.getByRole('button', { name: '利用日に設定' }).click();
  await assignRequest;
  await expect(page.getByText('指定日のメニューに設定しました。')).toBeVisible();

  const uniqueName = `UI追加-${Date.now()}`;
  await page.getByRole('button', { name: 'メニュー項目' }).click();
  const createPanel = page.locator('details.card').filter({ hasText: '新しいメニュー項目を登録' });
  await createPanel.locator('summary').click();
  await createPanel.getByLabel('種目名').fill(uniqueName);
  await createPanel.getByRole('button', { name: '胸（中部）を主働筋にする' }).click();
  await createPanel.locator('.muscle-group-tabs').getByRole('button', { name: '腕' }).click();
  await createPanel.getByRole('button', { name: '上腕三頭筋を補助筋にする' }).click();
  await createPanel.getByRole('button', { name: '肩の水平内転' }).click();
  await createPanel.getByLabel('使用する器具').selectOption('dumbbell');
  await createPanel.getByLabel('重量入力方式').selectOption('perSide');
  await createPanel.getByLabel('バーなどの固定重量').fill('20');
  await createPanel.getByLabel('種目の説明').fill('胸を張ってゆっくり動かす。');
  await createPanel.getByRole('button', { name: 'メニュー項目へ登録' }).click();

  const addedCard = page.locator('details.menu-item-library-card').filter({ hasText: uniqueName });
  await expect(addedCard).toBeVisible();
  await addedCard.locator('summary').click();
  await expect(addedCard.getByLabel('種目の説明')).toHaveValue('胸を張ってゆっくり動かす。');
  await expect(addedCard.getByLabel('バーなどの固定重量')).toHaveValue('20');
  await addedCard.getByRole('button', { name: '胸（上部）を主働筋にする' }).click();
  await addedCard.getByRole('button', { name: '胸（中部）を選択解除' }).click();
  await addedCard.getByRole('button', { name: '項目情報を保存' }).click();
  await expect(addedCard.getByLabel('バーなどの固定重量')).toHaveValue('20');
  await expect(addedCard.getByRole('button', { name: '胸（上部）を主働筋にする' })).toHaveAttribute('aria-pressed', 'true');
  await expect(addedCard.getByRole('button', { name: '胸（中部）を選択解除' })).toHaveAttribute('aria-pressed', 'true');

  page.once('dialog', (dialog) => dialog.accept());
  await addedCard.getByRole('button', { name: '項目を削除' }).click();
  await expect(page.locator('details.menu-item-library-card').filter({ hasText: uniqueName })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/training-menu');
  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  assert.equal(hasHorizontalOverflow, false);
});

test('iPhone幅で筋肉と役割を見やすく選択できる', async ({ page }) => {
  await attachCoreApiMock(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto('/training-menu');
  await page.getByRole('button', { name: 'メニュー項目' }).click();

  const createPanel = page.locator('details.card').filter({ hasText: '新しいメニュー項目を登録' });
  await createPanel.locator('summary').click();

  await expect(createPanel.locator('.muscle-group-tab')).toHaveCount(6);
  await expect(createPanel.getByRole('button', { name: '胸（中部）を主働筋にする' })).toBeVisible();
  await createPanel.getByRole('button', { name: '胸（中部）を主働筋にする' }).click();
  await expect(createPanel.locator('.muscle-target-chip.is-primary').filter({ hasText: '胸（中部）' })).toBeVisible();

  const layout = await createPanel.locator('.muscle-target-fieldset').evaluate((fieldset) => ({
    fitsWidth: fieldset.scrollWidth <= fieldset.clientWidth,
    names: [...fieldset.querySelectorAll('.muscle-target-name')].map((name) => ({
      text: name.textContent,
      width: name.getBoundingClientRect().width,
      height: name.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(getComputedStyle(name).lineHeight)
    }))
  }));
  assert.equal(layout.fitsWidth, true);
  assert.ok(layout.names.every((name) => name.width >= 80));
  assert.ok(layout.names.every((name) => name.height <= name.lineHeight * 1.5));

  await createPanel.screenshot({ path: 'test-results/muscle-target-mobile.png' });
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
  await page.getByLabel('筋肉量 (kg)').fill('52.1');
  await page.getByLabel('測定時刻').fill('07:30');
  await page.getByRole('slider', { name: '体調' }).fill('7');
  await page.getByRole('slider', { name: '気分' }).fill('8');
  await page.getByLabel('コメント').fill('体調はまずまず');
  await page.getByLabel('食事内容・栄養メモ').fill('朝：卵とヨーグルト\n昼：鶏肉とご飯');
  await page.getByPlaceholder('今日の記録や気づき').fill('UIテストでDaily更新を確認');

  await page.getByPlaceholder('例: ジョギング 1km').fill('ジョギング 1km');
  await page.getByRole('button', { name: '追加', exact: true }).click();
  await expect(page.getByText('ジョギング 1km')).toBeVisible();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('保存しました。')).toBeVisible();

  await page.goto('/calendar');
  const todayCellAfter = page
    .locator('button.calendar-cell')
    .filter({ has: page.locator('.day-number', { hasText: String(dayNumber) }) })
    .first();
  await expect(todayCellAfter.locator('.calendar-rating-stripe').first()).toHaveAttribute('title', '体調 7/10');
});

test('iPhone幅で体重・体脂肪率・筋肉量が横一列に収まる', async ({ page }) => {
  await attachCoreApiMock(page);
  await login(page);
  for (const width of [320, 375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/daily/${state.todayYmd}`);

    const metricInputs = page.locator('.body-metric-value-field input');
    await expect(metricInputs).toHaveCount(3);
    await expect(page.getByLabel('測定時刻')).toBeVisible();
    const layout = await page.evaluate(() => {
      const toBox = (element) => {
        const { x, y, width: boxWidth, height } = element.getBoundingClientRect();
        return { x, y, width: boxWidth, height };
      };
      return {
        boxes: [...document.querySelectorAll('.body-metric-value-field input')].map(toBox),
        timeBox: toBox(document.querySelector('.body-metrics-time-row input')),
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth
      };
    });
    const { boxes, timeBox } = layout;
    assert.ok(
      Math.max(...boxes.map((box) => box.y)) - Math.min(...boxes.map((box) => box.y)) < 2,
      `metric input alignment failed at ${width}px: ${JSON.stringify(boxes)}`
    );
    assert.ok(boxes.every((box) => box.width >= 72));
    assert.ok(layout.contentWidth <= layout.viewportWidth);
    assert.ok(timeBox.y > boxes[0].y + boxes[0].height);
  }
});

test('Dailyで筋肉量を空欄に戻すと削除要求を送る', async ({ page }) => {
  await attachCoreApiMock(page);
  await login(page);
  await page.goto(`/daily/${state.todayYmd}`);

  const requestPromise = page.waitForRequest((request) => {
    if (request.method() !== 'PUT') return false;
    if (!new URL(request.url()).pathname.endsWith(`/daily-records/${state.todayYmd}`)) return false;
    return request.postDataJSON().muscleMassKg === null;
  });
  await page.getByLabel('筋肉量 (kg)').fill('');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const request = await requestPromise;
  assert.equal(request.postDataJSON().muscleMassKg, null);
  await expect(page.getByText('保存しました。')).toBeVisible();
});

test('AIチャットで送信とモック応答の表示ができる', async ({ page }) => {
  await attachCoreApiMock(page);
  await page.route('**/invocations**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream; charset=utf-8',
      body: [
        'event: chunk',
        `data: ${JSON.stringify({ chunk: '今日の混雑前提なら、優先1〜3を先に押さえましょう。' })}`,
        '',
        'event: done',
        `data: ${JSON.stringify({ runtimeSessionId: 'runtime-session-ui-test-000000000000' })}`,
        '',
        ''
      ].join('\n')
    });
  });
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
  await expect(page.getByText('AIコーチキャラクター設定を保存しました。')).toBeVisible();

  await page.getByRole('button', { name: 'ログアウト' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
});

test('コーチング方針と短期メモを管理できる', async ({ page }) => {
  await attachCoreApiMock(page);
  await login(page);
  await page.goto('/settings');
  await page.getByRole('link', { name: 'コーチング方針を管理' }).click();
  await expect(page).toHaveURL(/\/coaching-context$/);

  await page.getByLabel('現在のトレーニング方針').fill('4週間はフォームと回復を優先する');
  await page.getByLabel('変更理由（必須）').fill('UIテストで方針を更新');
  await page.getByRole('button', { name: 'この内容で更新' }).click();
  await expect(page.getByText('コーチング方針を保存しました。次のAI相談から共有されます。')).toBeVisible();
  await expect(page.getByText('現在の版: 2')).toBeVisible();

  await page.getByLabel('内容').fill('次回は肩の違和感を確認する');
  await page.getByRole('button', { name: 'メモを追加' }).click();
  await expect(page.getByText('次回は肩の違和感を確認する')).toBeVisible();
  await expect(page.getByText('1 / 50件')).toBeVisible();
});

test('iPhone幅のコーチング方針画面が横にはみ出さない', async ({ page }) => {
  await attachCoreApiMock(page);
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/coaching-context');
  await expect(page.getByRole('heading', { name: 'コーチング方針' })).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    contentWidth: document.documentElement.scrollWidth
  }));
  assert.ok(
    dimensions.contentWidth <= dimensions.viewportWidth,
    `content width ${dimensions.contentWidth} exceeds viewport ${dimensions.viewportWidth}`
  );
});

test('設定画面から全期間の分析用JSONをダウンロードできる', async ({ page }) => {
  await attachCoreApiMock(page);
  await login(page);
  await page.goto('/settings');

  await page.getByLabel('保存されている全期間').check();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '分析用JSONをダウンロード' }).click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^kintrain-analysis_all_.*\.json$/);

  const downloadPath = await download.path();
  assert.ok(downloadPath);
  const exported = JSON.parse(await readFile(downloadPath, 'utf8'));
  assert.equal(exported.schema, 'kintrain.analysis-export');
  assert.equal(exported.schemaVersion, 7);
  assert.equal(exported.selection.rangeMode, 'allAvailable');
  assert.equal(exported.coverage.dailyRecordCount, 1);
  assert.equal(exported.coverage.gymVisitCount, 1);
  assert.equal(exported.coverage.recoveryExecutionCount, 0);
  assert.equal(exported.history.dailyRecords[0].bodyWeightKg, 69.8);
  assert.equal(exported.history.dailyRecords[0].muscleMassKg, 52.1);
  assert.equal(exported.history.dailyRecords[0].mealNotes, '朝：卵とヨーグルト');
  assert.equal(exported.history.gymVisits[0].entries[0].trainingName, 'チェストプレス');
  assert.equal(exported.history.gymVisits[0].entries[0].weightInputMode, 'legacyUnspecified');
  assert.equal(exported.history.gymVisits[0].entries[0].calculatedTotalWeightKg, null);
  assert.equal(JSON.stringify(exported).includes('setDetails'), false);
  await expect(page.getByText(/ダウンロードしました。デイリー記録 1件、トレーニング記録 1件、リカバリー記録 0件/)).toBeVisible();
});
