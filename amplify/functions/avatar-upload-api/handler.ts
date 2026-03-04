import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { S3Client } from "@aws-sdk/client-s3";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  AvatarUploadTarget,
  buildAvatarObjectKey,
  getAvatarMaxBytes,
  isAllowedAvatarContentType,
  resolveAvatarExtension
} from "../shared/avatar-storage";
import { getUserId, normalizePath, parseBody, response, toNonEmptyString } from "../shared/http";

const avatarBucketName = process.env.AVATAR_BUCKET_NAME ?? "";
const maxAvatarBytes = getAvatarMaxBytes();
const s3 = new S3Client({});

type PresignRequest = {
  target?: AvatarUploadTarget;
  fileName?: string;
  contentType?: string;
  fileSizeBytes?: number;
};

function normalizeTarget(value: unknown): AvatarUploadTarget | undefined {
  if (value === "user" || value === "coach") {
    return value;
  }
  return undefined;
}

async function createAvatarUploadPresign(
  event: APIGatewayProxyEvent,
  userId: string
): Promise<APIGatewayProxyResult> {
  const body = parseBody<PresignRequest>(event);
  if (!body) {
    return response(400, { message: "Invalid JSON body." });
  }

  const target = normalizeTarget(body.target);
  if (!target) {
    return response(400, { message: "target must be 'user' or 'coach'." });
  }

  const contentType = toNonEmptyString(body.contentType)?.toLowerCase();
  if (!contentType || !isAllowedAvatarContentType(contentType)) {
    return response(400, { message: "Unsupported image type. Use PNG, JPEG, or WEBP." });
  }

  if (typeof body.fileSizeBytes === "number" && Number.isFinite(body.fileSizeBytes) && body.fileSizeBytes > maxAvatarBytes) {
    return response(400, { message: `Image size exceeds limit (${maxAvatarBytes} bytes).` });
  }

  const extension = resolveAvatarExtension(contentType, body.fileName);
  const objectKey = buildAvatarObjectKey(userId, target, extension);

  const presignedPost = await createPresignedPost(s3, {
    Bucket: avatarBucketName,
    Key: objectKey,
    Expires: 300,
    Fields: {
      "Content-Type": contentType,
      key: objectKey
    },
    Conditions: [
      ["eq", "$Content-Type", contentType],
      ["eq", "$key", objectKey],
      ["content-length-range", 1, maxAvatarBytes]
    ]
  });

  return response(200, {
    uploadUrl: presignedPost.url,
    fields: presignedPost.fields,
    objectKey,
    expiresInSeconds: 300,
    maxSizeBytes: maxAvatarBytes
  });
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if (!avatarBucketName) {
    return response(500, { message: "Lambda environment is not configured." });
  }

  const userId = getUserId(event);
  if (!userId) {
    return response(401, { message: "Unauthorized" });
  }

  const path = normalizePath(event);
  const method = event.httpMethod.toUpperCase();

  if ((path === "/avatar-upload/presign" || path === "/avatar-upload/presign/") && method === "POST") {
    return createAvatarUploadPresign(event, userId);
  }

  return response(404, { message: "Not found" });
};
