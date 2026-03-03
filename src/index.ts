import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs"
import type { S3Event } from "aws-lambda"
import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs"

const REGION = "us-east-2"
const QUEUE_URL = "https://sqs.us-east-2.amazonaws.com/472514710669/get-notified-queue-upon-s3-upload"

const client = new SQSClient({ region: REGION })
const ecsClient = new ECSClient({ region: REGION })

function isS3TestEvent(event: unknown): event is { Event: string } {
  if (!event || typeof event !== "object") {
    return false
  }

  return "Service" in event && "Event" in event && (event as { Event?: string }).Event === "s3:TestEvent"
}

// message polling logic
async function init() {
  const command = new ReceiveMessageCommand({
    QueueUrl: QUEUE_URL,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 20,
  })

  while (true) {
    const { Messages } = await client.send(command)
    if (!Messages) {
      console.log("No messages found")
      continue
    }

    for (const message of Messages) {
      const { MessageId, Body, ReceiptHandle } = message
      console.log(`Message ${MessageId} body: ${Body}`)

      if (!Body || !ReceiptHandle) {
        continue
      }

      try {
        const event = JSON.parse(Body) as S3Event | { Event: string }

        // Ignore and delete S3 test events.
        if (isS3TestEvent(event)) {
          await client.send(new DeleteMessageCommand({
            QueueUrl: QUEUE_URL,
            ReceiptHandle,
          }))
          continue
        }

        if (!('Records' in event) || !Array.isArray(event.Records)) {
          console.log(`Skipping unsupported message format for ${MessageId}`)
          await client.send(new DeleteMessageCommand({
            QueueUrl: QUEUE_URL,
            ReceiptHandle,
          }))
          continue
        }

        for (const record of event.Records) {
          const { s3 } = record
          const { bucket, object: { key } } = s3

          const runTaskCommand = new RunTaskCommand({
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
          })

          await ecsClient.send(runTaskCommand)
        }

        // Delete after all records are processed successfully.
        await client.send(new DeleteMessageCommand({
          QueueUrl: QUEUE_URL,
          ReceiptHandle,
        }))
      } catch (e) {
        console.log(`Failed to process message ${MessageId}:`, e)
      }
    }
  }
}

init().catch((e) => {
  console.error("Fatal poller error:", e)
})
