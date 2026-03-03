"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const client_sqs_1 = require("@aws-sdk/client-sqs");
const client_ecs_1 = require("@aws-sdk/client-ecs");
const REGION = "us-east-2";
const QUEUE_URL = "https://sqs.us-east-2.amazonaws.com/472514710669/get-notified-queue-upon-s3-upload";
const client = new client_sqs_1.SQSClient({ region: REGION });
const ecsClient = new client_ecs_1.ECSClient({ region: REGION });
function isS3TestEvent(event) {
    if (!event || typeof event !== "object") {
        return false;
    }
    return "Service" in event && "Event" in event && event.Event === "s3:TestEvent";
}
// message polling logic
function init() {
    return __awaiter(this, void 0, void 0, function* () {
        const command = new client_sqs_1.ReceiveMessageCommand({
            QueueUrl: QUEUE_URL,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 20,
        });
        while (true) {
            const { Messages } = yield client.send(command);
            if (!Messages) {
                console.log("No messages found");
                continue;
            }
            for (const message of Messages) {
                const { MessageId, Body, ReceiptHandle } = message;
                console.log(`Message ${MessageId} body: ${Body}`);
                if (!Body || !ReceiptHandle) {
                    continue;
                }
                try {
                    const event = JSON.parse(Body);
                    // Ignore and delete S3 test events.
                    if (isS3TestEvent(event)) {
                        yield client.send(new client_sqs_1.DeleteMessageCommand({
                            QueueUrl: QUEUE_URL,
                            ReceiptHandle,
                        }));
                        continue;
                    }
                    if (!('Records' in event) || !Array.isArray(event.Records)) {
                        console.log(`Skipping unsupported message format for ${MessageId}`);
                        yield client.send(new client_sqs_1.DeleteMessageCommand({
                            QueueUrl: QUEUE_URL,
                            ReceiptHandle,
                        }));
                        continue;
                    }
                    for (const record of event.Records) {
                        const { s3 } = record;
                        const { bucket, object: { key } } = s3;
                        const runTaskCommand = new client_ecs_1.RunTaskCommand({
                            taskDefinition: "arn:aws:ecs:us-east-2:472514710669:task-definition/video-transcoder",
                            cluster: "arn:aws:ecs:us-east-2:472514710669:cluster/video-ecs",
                            launchType: "FARGATE",
                            networkConfiguration: {
                                awsvpcConfiguration: {
                                    subnets: ["subnet-0fe17f9d8871e5e85", "subnet-08a8ed6fd24bdcdc0", "subnet-015138e27f6b8d99b"],
                                    securityGroups: ["sg-0e945d46b13a9479d"],
                                    assignPublicIp: "ENABLED",
                                },
                            },
                            overrides: {
                                containerOverrides: [
                                    {
                                        name: "video-transcoder",
                                        environment: [
                                            {
                                                name: "BUCKET",
                                                value: bucket.name,
                                            },
                                            {
                                                name: "KEY",
                                                value: key,
                                            },
                                        ],
                                    },
                                ],
                            },
                        });
                        yield ecsClient.send(runTaskCommand);
                    }
                    // Delete after all records are processed successfully.
                    yield client.send(new client_sqs_1.DeleteMessageCommand({
                        QueueUrl: QUEUE_URL,
                        ReceiptHandle,
                    }));
                }
                catch (e) {
                    console.log(`Failed to process message ${MessageId}:`, e);
                }
            }
        }
    });
}
init().catch((e) => {
    console.error("Fatal poller error:", e);
});
