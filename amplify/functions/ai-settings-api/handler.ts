import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { buildAvatarImageUrl, normalizeOwnedAvatarObjectKey } from "../shared/avatar-storage";
import { ddb } from "../shared/ddb";
import { getUserId, normalizePath, nowIsoSeconds, parseBody, response, toNonEmptyString } from "../shared/http";

const aiSettingTableName = process.env.AI_SETTING_TABLE_NAME ?? "";
const avatarBucketName = process.env.AVATAR_BUCKET_NAME ?? "";
const defaultAiCoachAvatarUrl = process.env.AI_COACH_DEFAULT_AVATAR_URL ?? "/assets/characters/default.png";

type AiCharacterProfile = {
  characterId: string;
  characterName: string;
  coachAvatarObjectKey?: string;
  avatarImageUrl: string;
  tonePreset: string;
  characterDescription: string;
  speechEnding: string;
  createdAt?: string;
  updatedAt?: string;
};

function defaultAiCharacterProfile(): AiCharacterProfile {
  return {
    characterId: "ai-coach-default",
    characterName: "AIコーチ",
    coachAvatarObjectKey: undefined,
    avatarImageUrl: defaultAiCoachAvatarUrl,
    tonePreset: "friendly-coach",
    characterDescription: "優しく見守りAIコーチロボ",
    speechEnding: "です。ます。"
  };
}

async function getAiCharacterProfile(userId: string): Promise<APIGatewayProxyResult> {
  const result = await ddb.send(
    new GetCommand({
      TableName: aiSettingTableName,
      Key: { userId }
    })
  );

  if (!result.Item) {
    return response(200, defaultAiCharacterProfile());
  }

  const defaults = defaultAiCharacterProfile();
  const coachAvatarObjectKey = normalizeOwnedAvatarObjectKey(userId, "coach", result.Item.coachAvatarObjectKey);
  const avatarImageUrl = await buildAvatarImageUrl(avatarBucketName, coachAvatarObjectKey, defaults.avatarImageUrl);

  return response(200, {
    characterId: result.Item.characterId ?? defaults.characterId,
    characterName: result.Item.characterName ?? defaults.characterName,
    coachAvatarObjectKey,
    avatarImageUrl,
    tonePreset: result.Item.tonePreset ?? defaults.tonePreset,
    characterDescription: result.Item.characterDescription ?? defaults.characterDescription,
    speechEnding: result.Item.speechEnding ?? defaults.speechEnding,
    updatedAt: result.Item.updatedAt
  });
}

async function putAiCharacterProfile(
  event: APIGatewayProxyEvent,
  userId: string
): Promise<APIGatewayProxyResult> {
  const body = parseBody<Partial<AiCharacterProfile>>(event);
  if (!body) {
    return response(400, { message: "Invalid JSON body." });
  }

  const current = await ddb.send(
    new GetCommand({
      TableName: aiSettingTableName,
      Key: { userId }
    })
  );

  const defaults = defaultAiCharacterProfile();
  const createdAt = (current.Item?.createdAt as string | undefined) ?? nowIsoSeconds();
  const updatedAt = nowIsoSeconds();
  const currentAvatarObjectKey = normalizeOwnedAvatarObjectKey(userId, "coach", current.Item?.coachAvatarObjectKey);
  const bodyAvatarObjectKey = (body as { coachAvatarObjectKey?: string | null }).coachAvatarObjectKey;

  let coachAvatarObjectKey = currentAvatarObjectKey;
  if (bodyAvatarObjectKey === null) {
    coachAvatarObjectKey = undefined;
  } else if (bodyAvatarObjectKey !== undefined) {
    const nextAvatarObjectKey = normalizeOwnedAvatarObjectKey(userId, "coach", bodyAvatarObjectKey);
    if (!nextAvatarObjectKey) {
      return response(400, { message: "Invalid coachAvatarObjectKey." });
    }
    coachAvatarObjectKey = nextAvatarObjectKey;
  }

  const profile = {
    characterId: toNonEmptyString(body.characterId) ?? (current.Item?.characterId as string | undefined) ?? defaults.characterId,
    characterName:
      toNonEmptyString(body.characterName) ?? (current.Item?.characterName as string | undefined) ?? defaults.characterName,
    coachAvatarObjectKey,
    tonePreset: toNonEmptyString(body.tonePreset) ?? (current.Item?.tonePreset as string | undefined) ?? defaults.tonePreset,
    characterDescription:
      toNonEmptyString(body.characterDescription) ??
      (current.Item?.characterDescription as string | undefined) ??
      defaults.characterDescription,
    speechEnding:
      toNonEmptyString(body.speechEnding) ?? (current.Item?.speechEnding as string | undefined) ?? defaults.speechEnding,
    createdAt,
    updatedAt
  };

  const avatarImageUrl = await buildAvatarImageUrl(avatarBucketName, coachAvatarObjectKey, defaults.avatarImageUrl);

  await ddb.send(
    new PutCommand({
      TableName: aiSettingTableName,
      Item: {
        userId,
        ...profile
      }
    })
  );

  return response(200, {
    ...profile,
    avatarImageUrl
  });
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if (!aiSettingTableName) {
    return response(500, { message: "Lambda environment is not configured." });
  }

  const userId = getUserId(event);
  if (!userId) {
    return response(401, { message: "Unauthorized" });
  }

  const path = normalizePath(event);
  const method = event.httpMethod.toUpperCase();

  if ((path === "/ai-character-profile" || path === "/ai-character-profile/") && method === "GET") {
    return getAiCharacterProfile(userId);
  }
  if ((path === "/ai-character-profile" || path === "/ai-character-profile/") && method === "PUT") {
    return putAiCharacterProfile(event, userId);
  }

  return response(404, { message: "Not found" });
};
