'use strict';
const { spawnSync } = require("child_process");
const { readFileSync, unlinkSync } = require("fs");
const AWS = require("aws-sdk");
const outputBucketName = process.env.TRANSCODED_SEGMENTS_BUCKET;
const startBucketName = process.env.NEW_VIDEO_BUCKET;
const s3 = new AWS.S3();
const DDB = new AWS.DynamoDB.DocumentClient();

const jobsTable = process.env.JOBS_TABLE;
const tasksTable = process.env.SEGMENTS_TABLE;

const transcodeVideo = async (segmentData) => {
  console.log('In transcodeVideo fx: ', segmentData);


  const inputPath = `https://s3.amazonaws.com/${startBucketName}/${segmentData.videoKey}`
  const outputPath = `/tmp/${segmentData.segmentName}-transcoded.mp4`


  console.log(`Spawning ffmpeg transcoding, inputPath is: ${inputPath}  outputPath is: ${outputPath}`)

  spawnSync(
    '/opt/ffmpeg/ffmpeg',
    [
      "-ss", segmentData.startTime,
      "-to", segmentData.endTime,
      "-i", inputPath,
      "-c:v", "libx264", "-c:a", "copy", outputPath
    ],
    { stdio: "inherit" }
  )
  // read file from disk
  console.log(`Trying to read file at: ${outputPath}`)
  const transcodedVideo = readFileSync(outputPath);

  // delete local files
  console.log(`Trying to delete ${outputPath}`)
  unlinkSync(outputPath);

  console.log(`Trying to delete ${inputPath}`)
  // unlinkSync(inputPath);

  await s3
    .putObject({
      Bucket: outputBucketName,
      Key: `${segmentData.jobId}/${segmentData.segmentName}.mp4`,
      Body: transcodedVideo
    })
    .promise();
}

const recordTransaction = async (segmentData) => {
  console.log('In recordTransaction fx: ', segmentData);

  // build transaction params
  const subTaskParams = {
    Key: {
      "jobId": segmentData.jobId,
      "id": segmentData.segmentId
    },
    TableName: tasksTable,
    UpdateExpression: 'SET #s = :new_status',
    ConditionExpression: '#s = :pending',
    ExpressionAttributeNames: {
      '#s': 'status'
    },
    ExpressionAttributeValues: {
      ':new_status': 'completed',
      ':pending': 'pending'
    },
    ReturnValues: "UPDATED_NEW"
  };

  const jobParams = {
    Key: {
      "id": segmentData.jobId
    },
    TableName: jobsTable,
    UpdateExpression: 'SET finishedTasks = finishedTasks + :val',
    ExpressionAttributeValues: {
      ':val': 1
    },
    ReturnValues: "UPDATED_NEW"
  };


  console.log('Attempting write to segments table: ', JSON.stringify(subTaskParams));
  let transactionResult = await DDB.update(subTaskParams).promise()
    .then(data => {
      console.log("UpdateItem succeeded:", JSON.stringify(data, null, 2));
      return data;
    })
    .catch(err => {
      console.error("Unable to update item. Error JSON:", JSON.stringify(err, null, 2))
      return null;
    });

  if (transactionResult) {
    console.log('Attempting write to jobs table: ', JSON.stringify(jobParams));
    return await DDB.update(jobParams).promise()
      .then(data => {
        console.log("UpdateItem succeeded:", JSON.stringify(data, null, 2));
        return data;
      })
      .catch(err => {
        console.error("Unable to update item. Error JSON:", JSON.stringify(err, null, 2))
        return null;
      });
  }
}


/*
{
  videoKey: 'humility_original.mp4',
  jobId: '1584375307747',
  segmentName: '1584375307747-039',
  startTime: '92.640000',
  endTime: '96.000000'
}
*/
module.exports.transcode = async (event) => {
  const simulateInvoke = event.simulateInvoke;
  if (!event.segmentData) {
    console.log("not an bento-exec invocation!");
    return;
  }

  // grab data sent from event

  const segmentData = { ...event.segmentData };
  segmentData.segmentId = segmentData.segmentName.split('-')[1];  // => 000
  console.log(`Starting transcode function for ${JSON.stringify(segmentData)}`)


  if (simulateInvoke) {
    console.log('Simulating invoke: Skipping segment table read.');
  } else {
    // create params for DDB queries
    const getSubTaskParams = {
      TableName: tasksTable,
      Key: {
        "jobId": segmentData.jobId,
        "id": segmentData.segmentId
      }
    };

    // grab subtask data from DDB
    // NOTE: DDB.get returns an empty object if it can't find a record that matches the query. must test for this condition
    const subtaskData = await DDB.get(getSubTaskParams).promise()
      .then(data => {
        console.log("Get subtask succeeded:", JSON.stringify(data, null, 2));
        return data;
      })
      .catch(err => console.error("Unable to read item. Error JSON:", JSON.stringify(err, null, 2)));

    // if segment already transcoded, exit function
    if (!subtaskData.Item.status || subtaskData.Item.status !== 'pending') {
      console.log("Segment not in pending state. Current status: ", subtaskData.Item.status)
      return;
    }
  }

  await transcodeVideo(segmentData);

  if (simulateInvoke) {
    console.log('Transcode simulation complete! Exiting..');
    return;
  }
  await recordTransaction(segmentData);
};


