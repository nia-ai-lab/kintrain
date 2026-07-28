import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  appendCoachingNoteData,
  CoachingNoteLimitError,
  CoachingValidationError,
  CoachingVersionConflictError,
  deleteCoachingNoteData,
  getCoachingContextData,
  maxActiveCoachingNotes,
  maxCoachingRevisions,
  maxReturnedCoachingNotes,
  coachingNoteRetentionDays,
  coachingRevisionRetentionDays,
  updateCoachingContextData
} from "../shared/coaching-context-store";
import { getUserId, normalizePath, parseBody, response } from "../shared/http";

const coachingContextTableName = process.env.COACHING_CONTEXT_TABLE_NAME ?? "";

function errorResponse(error: unknown): APIGatewayProxyResult {
  if (error instanceof CoachingValidationError) {
    return response(400, { message: error.message });
  }
  if (error instanceof CoachingVersionConflictError) {
    return response(409, {
      message: "コーチング方針が別の操作で更新されました。画面を再読み込みしてください。",
      currentVersion: error.currentVersion
    });
  }
  if (error instanceof CoachingNoteLimitError) {
    return response(409, {
      message: `有効な引き継ぎメモは最大${maxActiveCoachingNotes}件です。不要なメモを削除してください。`
    });
  }
  return response(500, { message: "Internal error." });
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if (!coachingContextTableName) {
    return response(500, { message: "Lambda environment is not configured." });
  }
  const userId = getUserId(event);
  if (!userId) {
    return response(401, { message: "Unauthorized" });
  }

  const path = normalizePath(event);
  const method = event.httpMethod.toUpperCase();

  try {
    if ((path === "/coaching-context" || path === "/coaching-context/") && method === "GET") {
      const data = await getCoachingContextData(coachingContextTableName, userId);
      return response(200, {
        ...data,
        notes: data.notes.slice(0, maxActiveCoachingNotes),
        limits: {
          activeNotes: maxActiveCoachingNotes,
          returnedToAi: maxReturnedCoachingNotes,
          noteRetentionDays: coachingNoteRetentionDays,
          revisions: maxCoachingRevisions,
          revisionRetentionDays: coachingRevisionRetentionDays
        }
      });
    }

    if ((path === "/coaching-context" || path === "/coaching-context/") && method === "PUT") {
      const body = parseBody<Record<string, unknown>>(event);
      if (!body) {
        return response(400, { message: "Invalid JSON body." });
      }
      const context = await updateCoachingContextData(coachingContextTableName, userId, {
        ...body,
        source: "user"
      });
      return response(200, context);
    }

    if ((path === "/coaching-notes" || path === "/coaching-notes/") && method === "POST") {
      const body = parseBody<Record<string, unknown>>(event);
      if (!body) {
        return response(400, { message: "Invalid JSON body." });
      }
      const result = await appendCoachingNoteData(coachingContextTableName, userId, {
        ...body,
        source: "user"
      });
      return response(result.created ? 201 : 200, result);
    }

    const noteMatch = /^\/coaching-notes\/([^/]+)\/?$/.exec(path);
    if (noteMatch && method === "DELETE") {
      await deleteCoachingNoteData(coachingContextTableName, userId, decodeURIComponent(noteMatch[1]));
      return response(204, {});
    }

    return response(404, { message: "Not found" });
  } catch (error) {
    return errorResponse(error);
  }
};
