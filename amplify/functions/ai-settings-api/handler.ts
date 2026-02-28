import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ddb } from "../shared/ddb";
import { getUserId, normalizePath, nowIsoSeconds, parseBody, response, toNonEmptyString } from "../shared/http";

const aiSettingTableName = process.env.AI_SETTING_TABLE_NAME ?? "";

type AiCharacterProfile = {
  characterId: string;
  characterName: string;
  avatarImageUrl: string;
  tonePreset: string;
  createdAt?: string;
  updatedAt?: string;
};

function defaultAiCharacterProfile(): AiCharacterProfile {
  return {
    characterId: "nyaruko",
    characterName: "ニャル子",
    avatarImageUrl: "/assets/characters/nyaruko/expressions/default.png",
    tonePreset: "friendly-coach"
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

  return response(200, {
    characterId: result.Item.characterId ?? "nyaruko",
    characterName: result.Item.characterName ?? "ニャル子",
    avatarImageUrl: result.Item.avatarImageUrl ?? "/assets/characters/nyaruko/expressions/default.png",
    tonePreset: result.Item.tonePreset ?? "friendly-coach",
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

  const profile = {
    characterId: toNonEmptyString(body.characterId) ?? (current.Item?.characterId as string | undefined) ?? defaults.characterId,
    characterName:
      toNonEmptyString(body.characterName) ?? (current.Item?.characterName as string | undefined) ?? defaults.characterName,
    avatarImageUrl:
      toNonEmptyString(body.avatarImageUrl) ?? (current.Item?.avatarImageUrl as string | undefined) ?? defaults.avatarImageUrl,
    tonePreset: toNonEmptyString(body.tonePreset) ?? (current.Item?.tonePreset as string | undefined) ?? defaults.tonePreset,
    createdAt,
    updatedAt
  };

  await ddb.send(
    new PutCommand({
      TableName: aiSettingTableName,
      Item: {
        userId,
        ...profile
      }
    })
  );

  return response(200, profile);
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
