import { defineBackend } from "@aws-amplify/backend";
import { RemovalPolicy } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { auth } from "./auth/resource";
import { aiSettingsApiFunction } from "./functions/ai-settings-api/resource";
import { dailyRecordApiFunction } from "./functions/daily-record-api/resource";
import { profileApiFunction } from "./functions/profile-api/resource";
import { trainingHistoryApiFunction } from "./functions/training-history-api/resource";
import { trainingMenuApiFunction } from "./functions/training-menu-api/resource";

const backend = defineBackend({
  auth,
  profileApiFunction,
  trainingMenuApiFunction,
  trainingHistoryApiFunction,
  dailyRecordApiFunction,
  aiSettingsApiFunction
});

const stack = backend.profileApiFunction.resources.lambda.stack;

const userProfileTable = new dynamodb.Table(stack, "UserProfileTable", {
  tableName: "KinTrainUserProfileV2",
  partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  removalPolicy: RemovalPolicy.RETAIN
});

const trainingMenuTable = new dynamodb.Table(stack, "TrainingMenuTable", {
  tableName: "KinTrainTrainingMenuV2",
  partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "trainingMenuItemId", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  removalPolicy: RemovalPolicy.RETAIN
});

trainingMenuTable.addGlobalSecondaryIndex({
  indexName: "UserDisplayOrderIndex",
  partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "displayOrder", type: dynamodb.AttributeType.NUMBER }
});

trainingMenuTable.addGlobalSecondaryIndex({
  indexName: "UserTrainingNameIndex",
  partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "normalizedTrainingName", type: dynamodb.AttributeType.STRING }
});

const trainingHistoryTable = new dynamodb.Table(stack, "TrainingHistoryTable", {
  tableName: "KinTrainTrainingHistoryV2",
  partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "visitId", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  removalPolicy: RemovalPolicy.RETAIN
});

trainingHistoryTable.addGlobalSecondaryIndex({
  indexName: "UserStartedAtIndex",
  partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "startedAtUtc", type: dynamodb.AttributeType.STRING }
});

const dailyRecordTable = new dynamodb.Table(stack, "DailyRecordTable", {
  tableName: "KinTrainDailyRecordV2",
  partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "recordDate", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  removalPolicy: RemovalPolicy.RETAIN
});

const goalTable = new dynamodb.Table(stack, "GoalTable", {
  tableName: "KinTrainGoalV2",
  partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  removalPolicy: RemovalPolicy.RETAIN
});

const aiSettingTable = new dynamodb.Table(stack, "AiSettingTable", {
  tableName: "KinTrainAiSettingV2",
  partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  removalPolicy: RemovalPolicy.RETAIN
});

const profileApiLambda = backend.profileApiFunction.resources.lambda as lambda.Function;
const trainingMenuApiLambda = backend.trainingMenuApiFunction.resources.lambda as lambda.Function;
const trainingHistoryApiLambda = backend.trainingHistoryApiFunction.resources.lambda as lambda.Function;
const dailyRecordApiLambda = backend.dailyRecordApiFunction.resources.lambda as lambda.Function;
const aiSettingsApiLambda = backend.aiSettingsApiFunction.resources.lambda as lambda.Function;

userProfileTable.grantReadWriteData(profileApiLambda);
trainingMenuTable.grantReadWriteData(trainingMenuApiLambda);
trainingHistoryTable.grantReadWriteData(trainingHistoryApiLambda);
trainingMenuTable.grantReadData(trainingHistoryApiLambda);
dailyRecordTable.grantReadWriteData(dailyRecordApiLambda);
trainingHistoryTable.grantReadData(dailyRecordApiLambda);
goalTable.grantReadWriteData(dailyRecordApiLambda);
aiSettingTable.grantReadWriteData(aiSettingsApiLambda);

profileApiLambda.addEnvironment("USER_PROFILE_TABLE_NAME", userProfileTable.tableName);
trainingMenuApiLambda.addEnvironment("TRAINING_MENU_TABLE_NAME", trainingMenuTable.tableName);
trainingHistoryApiLambda.addEnvironment("TRAINING_HISTORY_TABLE_NAME", trainingHistoryTable.tableName);
trainingHistoryApiLambda.addEnvironment("TRAINING_MENU_TABLE_NAME", trainingMenuTable.tableName);
dailyRecordApiLambda.addEnvironment("DAILY_RECORD_TABLE_NAME", dailyRecordTable.tableName);
dailyRecordApiLambda.addEnvironment("TRAINING_HISTORY_TABLE_NAME", trainingHistoryTable.tableName);
dailyRecordApiLambda.addEnvironment("GOAL_TABLE_NAME", goalTable.tableName);
aiSettingsApiLambda.addEnvironment("AI_SETTING_TABLE_NAME", aiSettingTable.tableName);

const coreApi = new apigateway.RestApi(stack, "CoreApiGateway", {
  restApiName: "KinTrainCoreApi",
  defaultCorsPreflightOptions: {
    allowOrigins: apigateway.Cors.ALL_ORIGINS,
    allowMethods: apigateway.Cors.ALL_METHODS,
    allowHeaders: ["Content-Type", "Authorization"]
  }
});

const gatewayCorsResponseHeaders = {
  "Access-Control-Allow-Origin": "'*'",
  "Access-Control-Allow-Headers": "'Content-Type,Authorization'",
  "Access-Control-Allow-Methods": "'GET,POST,PUT,DELETE,OPTIONS'"
};

coreApi.addGatewayResponse("Default4xxWithCors", {
  type: apigateway.ResponseType.DEFAULT_4XX,
  responseHeaders: gatewayCorsResponseHeaders
});

coreApi.addGatewayResponse("Default5xxWithCors", {
  type: apigateway.ResponseType.DEFAULT_5XX,
  responseHeaders: gatewayCorsResponseHeaders
});

coreApi.addGatewayResponse("UnauthorizedWithCors", {
  type: apigateway.ResponseType.UNAUTHORIZED,
  responseHeaders: gatewayCorsResponseHeaders
});

coreApi.addGatewayResponse("AccessDeniedWithCors", {
  type: apigateway.ResponseType.ACCESS_DENIED,
  responseHeaders: gatewayCorsResponseHeaders
});

const authorizer = new apigateway.CognitoUserPoolsAuthorizer(stack, "CoreApiAuthorizer", {
  cognitoUserPools: [backend.auth.resources.userPool]
});

const profileIntegration = new apigateway.LambdaIntegration(profileApiLambda);
const trainingMenuIntegration = new apigateway.LambdaIntegration(trainingMenuApiLambda);
const trainingHistoryIntegration = new apigateway.LambdaIntegration(trainingHistoryApiLambda);
const dailyRecordIntegration = new apigateway.LambdaIntegration(dailyRecordApiLambda);
const aiSettingsIntegration = new apigateway.LambdaIntegration(aiSettingsApiLambda);

const authMethodOptions: apigateway.MethodOptions = {
  authorizer,
  authorizationType: apigateway.AuthorizationType.COGNITO,
  authorizationScopes: ["aws.cognito.signin.user.admin"]
};

const meResource = coreApi.root.addResource("me");
const meProfileResource = meResource.addResource("profile");
meProfileResource.addMethod("GET", profileIntegration, authMethodOptions);
meProfileResource.addMethod("PUT", profileIntegration, authMethodOptions);

const trainingMenuItemsResource = coreApi.root.addResource("training-menu-items");
trainingMenuItemsResource.addMethod("GET", trainingMenuIntegration, authMethodOptions);
trainingMenuItemsResource.addMethod("POST", trainingMenuIntegration, authMethodOptions);
const trainingMenuReorderResource = trainingMenuItemsResource.addResource("reorder");
trainingMenuReorderResource.addMethod("PUT", trainingMenuIntegration, authMethodOptions);
const trainingMenuItemResource = trainingMenuItemsResource.addResource("{trainingMenuItemId}");
trainingMenuItemResource.addMethod("PUT", trainingMenuIntegration, authMethodOptions);
trainingMenuItemResource.addMethod("DELETE", trainingMenuIntegration, authMethodOptions);

const trainingSessionViewResource = coreApi.root.addResource("training-session-view");
trainingSessionViewResource.addMethod("GET", trainingHistoryIntegration, authMethodOptions);

const gymVisitsResource = coreApi.root.addResource("gym-visits");
gymVisitsResource.addMethod("POST", trainingHistoryIntegration, authMethodOptions);
gymVisitsResource.addMethod("GET", trainingHistoryIntegration, authMethodOptions);
const gymVisitDetailResource = gymVisitsResource.addResource("{visitId}");
gymVisitDetailResource.addMethod("GET", trainingHistoryIntegration, authMethodOptions);
gymVisitDetailResource.addMethod("PUT", trainingHistoryIntegration, authMethodOptions);
gymVisitDetailResource.addMethod("DELETE", trainingHistoryIntegration, authMethodOptions);

const calendarResource = coreApi.root.addResource("calendar");
calendarResource.addMethod("GET", dailyRecordIntegration, authMethodOptions);
const goalsResource = coreApi.root.addResource("goals");
goalsResource.addMethod("GET", dailyRecordIntegration, authMethodOptions);
goalsResource.addMethod("PUT", dailyRecordIntegration, authMethodOptions);
const dailyRecordsResource = coreApi.root.addResource("daily-records");
dailyRecordsResource.addMethod("GET", dailyRecordIntegration, authMethodOptions);
const dailyRecordByDateResource = dailyRecordsResource.addResource("{date}");
dailyRecordByDateResource.addMethod("GET", dailyRecordIntegration, authMethodOptions);
dailyRecordByDateResource.addMethod("PUT", dailyRecordIntegration, authMethodOptions);

const aiCharacterProfileResource = coreApi.root.addResource("ai-character-profile");
aiCharacterProfileResource.addMethod("GET", aiSettingsIntegration, authMethodOptions);
aiCharacterProfileResource.addMethod("PUT", aiSettingsIntegration, authMethodOptions);

backend.addOutput({
  custom: {
    endpoints: {
      coreApiEndpoint: coreApi.url,
      // AiRuntimeEndpoint / AgentCore Gateway は次フェーズで追加実装する。
      aiRuntimeEndpoint: ""
    },
    dynamodb: {
      userProfileTableName: userProfileTable.tableName,
      trainingMenuTableName: trainingMenuTable.tableName,
      trainingHistoryTableName: trainingHistoryTable.tableName,
      dailyRecordTableName: dailyRecordTable.tableName,
      goalTableName: goalTable.tableName,
      aiSettingTableName: aiSettingTable.tableName
    }
  }
});
