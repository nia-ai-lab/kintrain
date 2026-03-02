import { defineBackend } from "@aws-amplify/backend";
import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as agentcore from "@aws-cdk/aws-bedrock-agentcore-alpha";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as path from "node:path";
import { auth } from "./auth/resource";
import { aiSettingsApiFunction } from "./functions/ai-settings-api/resource";
import { dailyRecordApiFunction } from "./functions/daily-record-api/resource";
import { mcpToolsApiFunction } from "./functions/mcp-tools-api/resource";
import { profileApiFunction } from "./functions/profile-api/resource";
import { trainingHistoryApiFunction } from "./functions/training-history-api/resource";
import { trainingMenuApiFunction } from "./functions/training-menu-api/resource";

const backend = defineBackend({
  auth,
  profileApiFunction,
  trainingMenuApiFunction,
  trainingHistoryApiFunction,
  dailyRecordApiFunction,
  aiSettingsApiFunction,
  mcpToolsApiFunction
});

const stack = backend.profileApiFunction.resources.lambda.stack;

const userProfileTable = new dynamodb.Table(stack, "UserProfileTable", {
  partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  removalPolicy: RemovalPolicy.RETAIN
});

const trainingMenuTable = new dynamodb.Table(stack, "TrainingMenuTable", {
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

const trainingMenuSetTable = new dynamodb.Table(stack, "TrainingMenuSetTable", {
  partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "trainingMenuSetId", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  removalPolicy: RemovalPolicy.RETAIN
});

trainingMenuSetTable.addGlobalSecondaryIndex({
  indexName: "UserMenuSetByOrderIndex",
  partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "menuSetOrder", type: dynamodb.AttributeType.NUMBER }
});

trainingMenuSetTable.addGlobalSecondaryIndex({
  indexName: "UserDefaultMenuSetIndex",
  partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "defaultSetMarker", type: dynamodb.AttributeType.STRING }
});

const trainingMenuSetItemTable = new dynamodb.Table(stack, "TrainingMenuSetItemTable", {
  partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "trainingMenuSetItemId", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  removalPolicy: RemovalPolicy.RETAIN
});

trainingMenuSetItemTable.addGlobalSecondaryIndex({
  indexName: "UserSetItemsBySetOrderIndex",
  partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "menuSetOrderKey", type: dynamodb.AttributeType.STRING }
});

trainingMenuSetItemTable.addGlobalSecondaryIndex({
  indexName: "UserSetItemsBySetAndItemIndex",
  partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "menuSetItemKey", type: dynamodb.AttributeType.STRING }
});

trainingMenuSetItemTable.addGlobalSecondaryIndex({
  indexName: "UserSetItemsByMenuItemIndex",
  partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "trainingMenuItemId", type: dynamodb.AttributeType.STRING }
});

const trainingHistoryTable = new dynamodb.Table(stack, "TrainingHistoryTable", {
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
  partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "recordDate", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  removalPolicy: RemovalPolicy.RETAIN
});

const goalTable = new dynamodb.Table(stack, "GoalTable", {
  partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  removalPolicy: RemovalPolicy.RETAIN
});

const aiSettingTable = new dynamodb.Table(stack, "AiSettingTable", {
  partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  removalPolicy: RemovalPolicy.RETAIN
});

const aiAdviceLogTable = new dynamodb.Table(stack, "AiAdviceLogTable", {
  partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "adviceLogId", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  removalPolicy: RemovalPolicy.RETAIN
});

const profileApiLambda = backend.profileApiFunction.resources.lambda as lambda.Function;
const trainingMenuApiLambda = backend.trainingMenuApiFunction.resources.lambda as lambda.Function;
const trainingHistoryApiLambda = backend.trainingHistoryApiFunction.resources.lambda as lambda.Function;
const dailyRecordApiLambda = backend.dailyRecordApiFunction.resources.lambda as lambda.Function;
const aiSettingsApiLambda = backend.aiSettingsApiFunction.resources.lambda as lambda.Function;
const mcpToolsApiLambda = backend.mcpToolsApiFunction.resources.lambda as lambda.Function;

userProfileTable.grantReadWriteData(profileApiLambda);
trainingMenuTable.grantReadWriteData(trainingMenuApiLambda);
trainingMenuSetTable.grantReadWriteData(trainingMenuApiLambda);
trainingMenuSetItemTable.grantReadWriteData(trainingMenuApiLambda);
trainingHistoryTable.grantReadWriteData(trainingHistoryApiLambda);
trainingMenuTable.grantReadData(trainingHistoryApiLambda);
trainingMenuSetTable.grantReadData(trainingHistoryApiLambda);
trainingMenuSetItemTable.grantReadData(trainingHistoryApiLambda);
dailyRecordTable.grantReadWriteData(dailyRecordApiLambda);
trainingHistoryTable.grantReadData(dailyRecordApiLambda);
goalTable.grantReadWriteData(dailyRecordApiLambda);
aiSettingTable.grantReadWriteData(aiSettingsApiLambda);
trainingHistoryTable.grantReadData(mcpToolsApiLambda);
dailyRecordTable.grantReadData(mcpToolsApiLambda);
goalTable.grantReadData(mcpToolsApiLambda);
aiSettingTable.grantReadData(mcpToolsApiLambda);
aiAdviceLogTable.grantWriteData(mcpToolsApiLambda);

profileApiLambda.addEnvironment("USER_PROFILE_TABLE_NAME", userProfileTable.tableName);
trainingMenuApiLambda.addEnvironment("TRAINING_MENU_TABLE_NAME", trainingMenuTable.tableName);
trainingMenuApiLambda.addEnvironment("TRAINING_MENU_SET_TABLE_NAME", trainingMenuSetTable.tableName);
trainingMenuApiLambda.addEnvironment("TRAINING_MENU_SET_ITEM_TABLE_NAME", trainingMenuSetItemTable.tableName);
trainingHistoryApiLambda.addEnvironment("TRAINING_HISTORY_TABLE_NAME", trainingHistoryTable.tableName);
trainingHistoryApiLambda.addEnvironment("TRAINING_MENU_TABLE_NAME", trainingMenuTable.tableName);
trainingHistoryApiLambda.addEnvironment("TRAINING_MENU_SET_TABLE_NAME", trainingMenuSetTable.tableName);
trainingHistoryApiLambda.addEnvironment("TRAINING_MENU_SET_ITEM_TABLE_NAME", trainingMenuSetItemTable.tableName);
dailyRecordApiLambda.addEnvironment("DAILY_RECORD_TABLE_NAME", dailyRecordTable.tableName);
dailyRecordApiLambda.addEnvironment("TRAINING_HISTORY_TABLE_NAME", trainingHistoryTable.tableName);
dailyRecordApiLambda.addEnvironment("GOAL_TABLE_NAME", goalTable.tableName);
aiSettingsApiLambda.addEnvironment("AI_SETTING_TABLE_NAME", aiSettingTable.tableName);
mcpToolsApiLambda.addEnvironment("TRAINING_HISTORY_TABLE_NAME", trainingHistoryTable.tableName);
mcpToolsApiLambda.addEnvironment("DAILY_RECORD_TABLE_NAME", dailyRecordTable.tableName);
mcpToolsApiLambda.addEnvironment("GOAL_TABLE_NAME", goalTable.tableName);
mcpToolsApiLambda.addEnvironment("AI_SETTING_TABLE_NAME", aiSettingTable.tableName);
mcpToolsApiLambda.addEnvironment("AI_ADVICE_LOG_TABLE_NAME", aiAdviceLogTable.tableName);

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

const trainingMenuSetsResource = coreApi.root.addResource("training-menu-sets");
trainingMenuSetsResource.addMethod("GET", trainingMenuIntegration, authMethodOptions);
trainingMenuSetsResource.addMethod("POST", trainingMenuIntegration, authMethodOptions);
const trainingMenuSetResource = trainingMenuSetsResource.addResource("{trainingMenuSetId}");
trainingMenuSetResource.addMethod("PUT", trainingMenuIntegration, authMethodOptions);
trainingMenuSetResource.addMethod("DELETE", trainingMenuIntegration, authMethodOptions);
const trainingMenuSetItemsResource = trainingMenuSetResource.addResource("items");
trainingMenuSetItemsResource.addMethod("POST", trainingMenuIntegration, authMethodOptions);
const trainingMenuSetItemsReorderResource = trainingMenuSetItemsResource.addResource("reorder");
trainingMenuSetItemsReorderResource.addMethod("PUT", trainingMenuIntegration, authMethodOptions);
const trainingMenuSetItemResource = trainingMenuSetItemsResource.addResource("{trainingMenuItemId}");
trainingMenuSetItemResource.addMethod("DELETE", trainingMenuIntegration, authMethodOptions);

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

const enableAgentCoreResources = process.env.ENABLE_AGENTCORE_RESOURCES === "true";
let aiRuntimeEndpoint = process.env.AI_RUNTIME_ENDPOINT_URL ?? "";
let aiRuntimeEndpointArn = "";
let aiGatewayUrl = "";
let aiGatewayId = "";
let aiMemoryId = "";

function toAgentCoreNameSuffix(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "local";
}

function toAgentCoreStrictSuffix(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 16);
  return normalized || "local";
}

if (enableAgentCoreResources) {
  const agentCoreStack = backend.createStack("agentcore-stack");
  const cognitoDiscoveryUrl = `https://cognito-idp.${Stack.of(agentCoreStack).region}.amazonaws.com/${backend.auth.resources.userPool.userPoolId}/.well-known/openid-configuration`;
  const rawBranchName = process.env.AWS_BRANCH ?? process.env.AMPLIFY_BRANCH ?? "local";
  const branchSuffix = toAgentCoreNameSuffix(rawBranchName);
  const strictSuffix = toAgentCoreStrictSuffix(rawBranchName);
  const gatewayName = process.env.AI_COACH_GATEWAY_NAME ?? `kintrain-ai-coach-gateway-${branchSuffix}`;
  const memoryName = process.env.AI_COACH_MEMORY_NAME ?? `kintrainCoachMemory_${strictSuffix}`;
  const runtimeName = process.env.AI_COACH_RUNTIME_NAME ?? `kintrainCoachRuntime_${strictSuffix}`;

  const aiCoachGateway = new agentcore.Gateway(agentCoreStack, "AiCoachGateway", {
    gatewayName,
    description: "KinTrain AI coach MCP gateway",
    protocolConfiguration: agentcore.GatewayProtocol.mcp({
      instructions: "Use KinTrain tools to retrieve training records and provide concise coaching advice.",
      searchType: agentcore.McpGatewaySearchType.SEMANTIC,
      supportedVersions: [agentcore.MCPProtocolVersion.MCP_2025_03_26]
    }),
    authorizerConfiguration: agentcore.GatewayAuthorizer.usingCognito({
      userPool: backend.auth.resources.userPool,
      allowedScopes: ["aws.cognito.signin.user.admin"]
    })
  });

  aiCoachGateway.addLambdaTarget("KinTrainMcpTools", {
    gatewayTargetName: "kintrain-core-tools",
    description: "KinTrain MCP tools backed by Lambda + DynamoDB",
    lambdaFunction: mcpToolsApiLambda,
    toolSchema: agentcore.ToolSchema.fromLocalAsset(
      path.join(process.cwd(), "amplify", "agentcore", "tool-schemas", "mcp-tools.json")
    ),
    credentialProviderConfigurations: [agentcore.GatewayCredentialProvider.fromIamRole()]
  });

  const aiCoachMemory = new agentcore.Memory(agentCoreStack, "AiCoachMemory", {
    memoryName,
    description: "KinTrain long-term memory for AI coach conversation context",
    expirationDuration: Duration.days(90),
    memoryStrategies: [
      agentcore.MemoryStrategy.usingBuiltInUserPreference(),
      agentcore.MemoryStrategy.usingBuiltInSummarization(),
      agentcore.MemoryStrategy.usingBuiltInSemantic()
    ]
  });

  const aiCoachRuntime = new agentcore.Runtime(agentCoreStack, "AiCoachRuntime", {
    runtimeName,
    description: "KinTrain AI coach runtime (Strands / Python)",
    protocolConfiguration: agentcore.ProtocolType.HTTP,
    agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromCodeAsset({
      path: path.join(process.cwd(), "amplify", "agentcore", "runtime"),
      runtime: agentcore.AgentCoreRuntime.PYTHON_3_12,
      entrypoint: ["main.py"]
    }),
    authorizerConfiguration: agentcore.RuntimeAuthorizerConfiguration.usingJWT(
      cognitoDiscoveryUrl,
      undefined,
      undefined,
      ["aws.cognito.signin.user.admin"]
    ),
    requestHeaderConfiguration: {
      allowlistedHeaders: ["Authorization"]
    },
    environmentVariables: {
      MODEL_ID: process.env.MODEL_ID ?? "anthropic.claude-opus-4-6-v1",
      APP_TIMEZONE_DEFAULT: process.env.APP_TIMEZONE_DEFAULT ?? "Asia/Tokyo",
      MCP_GATEWAY_URL: aiCoachGateway.gatewayUrl ?? "",
      MEMORY_ID: aiCoachMemory.memoryId,
      SOUL_FILE_PATH: "config/prompts/SOUL.md",
      PERSONA_FILE_PATH: "config/prompts/PERSONA.md",
      SYSTEM_PROMPT_FILE_PATH: "config/prompts/system-prompt.ja.txt"
    }
  });

  aiCoachRuntime.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: ["*"]
    })
  );

  aiCoachGateway.grantInvoke(aiCoachRuntime.role);
  aiCoachMemory.grantRead(aiCoachRuntime.role);
  aiCoachMemory.grantWrite(aiCoachRuntime.role);

  const aiCoachRuntimeEndpoint = aiCoachRuntime.addEndpoint("prod");
  aiRuntimeEndpointArn = aiCoachRuntimeEndpoint.agentRuntimeEndpointArn;
  aiGatewayUrl = aiCoachGateway.gatewayUrl ?? "";
  aiGatewayId = aiCoachGateway.gatewayId;
  aiMemoryId = aiCoachMemory.memoryId;
}

backend.addOutput({
  custom: {
    endpoints: {
      coreApiEndpoint: coreApi.url,
      aiRuntimeEndpoint,
      aiRuntimeEndpointArn,
      aiGatewayUrl
    },
    agentCore: {
      enabled: enableAgentCoreResources ? "true" : "false",
      aiGatewayId,
      aiMemoryId
    },
    dynamodb: {
      userProfileTableName: userProfileTable.tableName,
      trainingMenuTableName: trainingMenuTable.tableName,
      trainingMenuSetTableName: trainingMenuSetTable.tableName,
      trainingMenuSetItemTableName: trainingMenuSetItemTable.tableName,
      trainingHistoryTableName: trainingHistoryTable.tableName,
      dailyRecordTableName: dailyRecordTable.tableName,
      goalTableName: goalTable.tableName,
      aiSettingTableName: aiSettingTable.tableName,
      aiAdviceLogTableName: aiAdviceLogTable.tableName
    }
  }
});
