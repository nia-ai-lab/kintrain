import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { buildAvatarImageUrl, deleteAvatarObject, normalizeOwnedAvatarObjectKey } from "../shared/avatar-storage";
import { ddb } from "../shared/ddb";
import { getUserId, normalizePath, nowIsoSeconds, parseBody, response, toNonEmptyString } from "../shared/http";

const userProfileTableName = process.env.USER_PROFILE_TABLE_NAME ?? "";
const avatarBucketName = process.env.AVATAR_BUCKET_NAME ?? "";

type UserProfile = {
  userName: string;
  sex: "male" | "female" | "other" | "no-answer";
  birthDate: string;
  heightCm: number | null;
  timeZoneId: string;
  userAvatarObjectKey?: string;
  userAvatarImageUrl?: string;
  createdAt?: string;
  updatedAt: string;
};

async function getProfile(userId: string): Promise<APIGatewayProxyResult> {
  const result = await ddb.send(
    new GetCommand({
      TableName: userProfileTableName,
      Key: { userId }
    })
  );

  if (!result.Item) {
    return response(200, {
      userName: "",
      sex: "no-answer",
      birthDate: "",
      heightCm: null,
      timeZoneId: "Asia/Tokyo",
      userAvatarObjectKey: undefined,
      userAvatarImageUrl: undefined
    });
  }

  const userAvatarObjectKey = normalizeOwnedAvatarObjectKey(userId, "user", result.Item.userAvatarObjectKey);
  const userAvatarImageUrl = await buildAvatarImageUrl(avatarBucketName, userAvatarObjectKey);

  return response(200, {
    userName: result.Item.userName ?? "",
    sex: result.Item.sex ?? "no-answer",
    birthDate: result.Item.birthDate ?? "",
    heightCm: typeof result.Item.heightCm === "number" ? result.Item.heightCm : null,
    timeZoneId: result.Item.timeZoneId ?? "Asia/Tokyo",
    userAvatarObjectKey,
    userAvatarImageUrl,
    updatedAt: result.Item.updatedAt
  });
}

async function putProfile(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  const body = parseBody<Partial<UserProfile>>(event);
  if (!body) {
    return response(400, { message: "Invalid JSON body." });
  }

  const current = await ddb.send(
    new GetCommand({
      TableName: userProfileTableName,
      Key: { userId }
    })
  );

  const createdAt = (current.Item?.createdAt as string | undefined) ?? nowIsoSeconds();
  const updatedAt = nowIsoSeconds();
  const currentAvatarObjectKey = normalizeOwnedAvatarObjectKey(userId, "user", current.Item?.userAvatarObjectKey);
  const bodyAvatarObjectKey = (body as { userAvatarObjectKey?: string | null }).userAvatarObjectKey;

  let userAvatarObjectKey = currentAvatarObjectKey;
  if (bodyAvatarObjectKey === null) {
    userAvatarObjectKey = undefined;
  } else if (bodyAvatarObjectKey !== undefined) {
    const nextAvatarObjectKey = normalizeOwnedAvatarObjectKey(userId, "user", bodyAvatarObjectKey);
    if (!nextAvatarObjectKey) {
      return response(400, { message: "Invalid userAvatarObjectKey." });
    }
    userAvatarObjectKey = nextAvatarObjectKey;
  }

  const profile: UserProfile = {
    userName: toNonEmptyString(body.userName) ?? (current.Item?.userName as string | undefined) ?? "",
    sex: (body.sex as UserProfile["sex"] | undefined) ?? (current.Item?.sex as UserProfile["sex"] | undefined) ?? "no-answer",
    birthDate: body.birthDate ?? (current.Item?.birthDate as string | undefined) ?? "",
    heightCm:
      typeof body.heightCm === "number"
        ? body.heightCm
        : typeof current.Item?.heightCm === "number"
          ? (current.Item.heightCm as number)
          : null,
    timeZoneId: toNonEmptyString(body.timeZoneId) ?? (current.Item?.timeZoneId as string | undefined) ?? "Asia/Tokyo",
    userAvatarObjectKey,
    createdAt,
    updatedAt
  };

  const userAvatarImageUrl = await buildAvatarImageUrl(avatarBucketName, userAvatarObjectKey);

  await ddb.send(
    new PutCommand({
      TableName: userProfileTableName,
      Item: {
        userId,
        ...profile
      }
    })
  );

  if (currentAvatarObjectKey && currentAvatarObjectKey !== userAvatarObjectKey) {
    await deleteAvatarObject(avatarBucketName, currentAvatarObjectKey);
  }

  return response(200, {
    ...profile,
    userAvatarImageUrl
  });
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if (!userProfileTableName) {
    return response(500, { message: "Lambda environment is not configured." });
  }

  const userId = getUserId(event);
  if (!userId) {
    return response(401, { message: "Unauthorized" });
  }

  const path = normalizePath(event);
  const method = event.httpMethod.toUpperCase();

  if ((path === "/me/profile" || path === "/me/profile/") && method === "GET") {
    return getProfile(userId);
  }

  if ((path === "/me/profile" || path === "/me/profile/") && method === "PUT") {
    return putProfile(event, userId);
  }

  return response(404, { message: "Not found" });
};
