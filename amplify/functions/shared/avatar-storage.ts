import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type AvatarUploadTarget = "user" | "coach";

const avatarS3Client = new S3Client({});

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

const contentTypeToExtension: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
};

export function getAvatarMaxBytes(): number {
  const parsed = Number(process.env.AVATAR_IMAGE_MAX_BYTES ?? DEFAULT_MAX_BYTES);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_BYTES;
  }
  return Math.floor(parsed);
}

export function isAllowedAvatarContentType(contentType: string): boolean {
  return Object.prototype.hasOwnProperty.call(contentTypeToExtension, contentType.trim().toLowerCase());
}

export function resolveAvatarExtension(contentType: string, fileName?: string): string {
  const normalizedContentType = contentType.trim().toLowerCase();
  const extByType = contentTypeToExtension[normalizedContentType];
  if (extByType) {
    return extByType;
  }

  const name = (fileName ?? "").trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) {
    const ext = name.slice(dot + 1);
    if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp") {
      return ext === "jpeg" ? "jpg" : ext;
    }
  }
  return "png";
}

export function buildAvatarObjectKey(userId: string, target: AvatarUploadTarget, extension: string): string {
  const now = Date.now();
  const random = Math.random().toString(36).slice(2, 10);
  const safeExt = extension.replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
  return `users/${userId}/avatars/${target}/${now}-${random}.${safeExt}`;
}

export function normalizeOwnedAvatarObjectKey(
  userId: string,
  target: AvatarUploadTarget,
  value: unknown
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const key = value.trim();
  if (!key) {
    return undefined;
  }
  const expectedPrefix = `users/${userId}/avatars/${target}/`;
  if (!key.startsWith(expectedPrefix)) {
    return undefined;
  }
  if (key.includes("..")) {
    return undefined;
  }
  return key;
}

export async function buildAvatarImageUrl(
  bucketName: string,
  objectKey: string | undefined,
  fallbackImageUrl?: string
): Promise<string | undefined> {
  if (!objectKey) {
    return fallbackImageUrl;
  }
  if (!bucketName) {
    return fallbackImageUrl;
  }
  try {
    return await getSignedUrl(
      avatarS3Client,
      new GetObjectCommand({
        Bucket: bucketName,
        Key: objectKey
      }),
      { expiresIn: 600 }
    );
  } catch {
    return fallbackImageUrl;
  }
}
