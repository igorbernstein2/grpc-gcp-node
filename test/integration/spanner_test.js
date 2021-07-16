/**
 * @license
 * Copyright 2018 gRPC authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

/**
 * @fileoverview Integration tests for spanner grpc requests.
 */

'use strict';

const PROTO_DIR = __dirname + '/../../third_party/googleapis';

const protoLoader = require('@grpc/proto-loader');
const assert = require('assert');
const {GoogleAuth} = require('google-auth-library');
const fs = require('fs');
const gax = require('google-gax');
const {Spanner} = require('@google-cloud/spanner');

const _TARGET = 'spanner.googleapis.com:443';
const _OAUTH_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const _MAX_RAND_ID = 1000000;
const _PROJECT_ID = 'long-door-651';
const _INSTANCE_ID =
  'test-instance-' + Math.floor(Math.random() * _MAX_RAND_ID);
const _DATABASE_ID = 'test-db-' + Math.floor(Math.random() * _MAX_RAND_ID);
const _TABLE_NAME = 'storage';
const _DATABASE =
  `projects/${_PROJECT_ID}/instances/${_INSTANCE_ID}/databases/${_DATABASE_ID}`;
const _TEST_SQL = `select id from ${_TABLE_NAME}`;
const _CONFIG_FILE = `${__dirname}/spanner.grpc.config`;

const getGrpcGcpObjects = require('../../build/src');

const spanner = new Spanner({projectId: _PROJECT_ID});
const instance = spanner.instance(_INSTANCE_ID);

const argIndex = process.argv.findIndex(value => value === '--grpclib');
assert.notStrictEqual(argIndex, -1, 'Please, specify grpc lib with --grpclib');
const grpcLibName = process.argv[argIndex + 1];

describe('Using ' + grpcLibName, () => {
  before(async function () {
    this.timeout(60000);
    // Create test instance.
    console.log(`Creating instance ${instance.formattedName_}.`);
    const [, instOp] = await instance.create({
      config: 'regional-us-central1',
      nodes: 1,
      displayName: 'grpc-gcp-node tests',
      labels: {
        ['grpc_gcp_node_tests']: 'true',
        created: Math.round(Date.now() / 1000).toString(), // current time
      },
    });

    console.log(`Waiting for operation on ${instance.id} to complete...`);
    await instOp.promise();
    console.log(`Created instance ${_INSTANCE_ID}.`);

    // Create test database.
    const [database, dbOp] = await instance.createDatabase(_DATABASE_ID);

    console.log(`Waiting for operation on ${database.id} to complete...`);
    await dbOp.promise();

    console.log(`Created database ${_DATABASE_ID} on instance ${_INSTANCE_ID}.`);

    // Create test table.
    const table = database.table(_TABLE_NAME);
    const schema =
        `CREATE TABLE ${_TABLE_NAME} (id STRING(1024)) PRIMARY KEY(id)`;

    const [, tableOp] = await table.create(schema);
    console.log(`Waiting for operation on ${table.id} to complete...`);
    await tableOp.promise();
    console.log(`Created table "${_TABLE_NAME}".`);

    // Populate test table.
    const row = {
      id: 'payload',
    };

    console.log(`Inserting row to the table...`);
    await table.insert(row);
    console.log(`Row inserted into table "${_TABLE_NAME}".`);
  });

  after(async function () {
    this.timeout(60000);
    // Delete test instance.
    console.log(`Deleting instance ${instance.id}...`);
    await instance.delete();
    console.log(`Deleted instance ${_INSTANCE_ID}.`);
  });

  const grpc = require(grpcLibName);
  const grpcGcp = getGrpcGcpObjects(grpc);
  describe('Spanner integration tests', () => {
    describe('SpannerClient generated by jspb', () => {
      const spannerPackageDef = protoLoader.loadSync(
        PROTO_DIR + '/google/spanner/v1/spanner.proto',
        {includeDirs: [PROTO_DIR]}
      );
      const spannerGrpc = grpc.loadPackageDefinition(spannerPackageDef);

      let client;
      let pool;

      beforeEach(async () => {
        const authFactory = new GoogleAuth();
        const auth = await authFactory.getClient();

        const sslCreds = grpc.credentials.createSsl();
        const callCreds = grpc.credentials.createFromGoogleCredential(auth);
        const channelCreds = grpc.credentials.combineChannelCredentials(
          sslCreds,
          callCreds
        );

        const apiDefinition = JSON.parse(fs.readFileSync(_CONFIG_FILE));
        const apiConfig = grpcGcp.createGcpApiConfig(apiDefinition);

        const channelOptions = {
          channelFactoryOverride: grpcGcp.gcpChannelFactoryOverride,
          callInvocationTransformer: grpcGcp.gcpCallInvocationTransformer,
          gcpApiConfig: apiConfig,
        };

        client = new spannerGrpc.google.spanner.v1.Spanner(
          _TARGET,
          channelCreds,
          channelOptions
        );

        pool = client.getChannel();
      });

      it('Test session operations', done => {
        const createSessionRequest = {database: _DATABASE};
        client.createSession(createSessionRequest, (err, session) => {
          assert.ifError(err);
          const sessionName = session.name;

          const getSessionRequest = {name: sessionName};
          client.getSession(getSessionRequest, (err, sessionResult) => {
            assert.ifError(err);
            assert.strictEqual(sessionResult.name, sessionName);

            const listSessionsRequest = {database: _DATABASE};
            client.listSessions(listSessionsRequest, (err, response) => {
              assert.ifError(err);
              const sessionsList = response.sessions;
              const sessionNames = sessionsList.map(session => session.name);
              assert(sessionNames.includes(sessionName));

              const deleteSessionRequest = {name: sessionName};
              client.deleteSession(deleteSessionRequest, err => {
                assert.ifError(err);
                done();
              });
            });
          });
        });
      });

      it('Test executeSql', done => {
        const createSessionRequest = {database: _DATABASE};
        client.createSession(createSessionRequest, (err, session) => {
          assert.ifError(err);
          const sessionName = session.name;

          assert.strictEqual(pool.channelRefs.length, 1);
          assert.strictEqual(pool.channelRefs[0].affinityCount, 1);
          assert.strictEqual(pool.channelRefs[0].activeStreamsCount, 0);

          const executeSqlRequest = {
            session: sessionName,
            sql: _TEST_SQL,
          };
          client.executeSql(executeSqlRequest, (err, resultSet) => {
            assert.ifError(err);
            assert.notStrictEqual(resultSet, null);
            const rowsList = resultSet.rows;
            const value = rowsList[0].values[0].stringValue;

            assert.strictEqual(value, 'payload');
            assert.strictEqual(pool.channelRefs.length, 1);
            assert.strictEqual(pool.channelRefs[0].affinityCount, 1);
            assert.strictEqual(pool.channelRefs[0].activeStreamsCount, 0);

            const deleteSessionRequest = {name: sessionName};
            client.deleteSession(deleteSessionRequest, err => {
              assert.ifError(err);
              assert.strictEqual(pool.channelRefs.length, 1);
              assert.strictEqual(pool.channelRefs[0].affinityCount, 0);
              assert.strictEqual(pool.channelRefs[0].activeStreamsCount, 0);
              done();
            });
          });
        });
      });

      it('Test executeStreamingSql', done => {
        const createSessionRequest = {database: _DATABASE};
        client.createSession(createSessionRequest, (err, session) => {
          assert.ifError(err);
          const sessionName = session.name;

          assert.strictEqual(pool.channelRefs.length, 1);
          assert.strictEqual(pool.channelRefs[0].affinityCount, 1);
          assert.strictEqual(pool.channelRefs[0].activeStreamsCount, 0);

          const executeSqlRequest = {
            session: sessionName,
            sql: _TEST_SQL,
          };
          const call = client.executeStreamingSql(executeSqlRequest);

          assert.strictEqual(pool.channelRefs.length, 1);
          assert.strictEqual(pool.channelRefs[0].affinityCount, 1);
          assert.strictEqual(pool.channelRefs[0].activeStreamsCount, 1);

          call.on('data', partialResultSet => {
            const value = partialResultSet.values[0].stringValue;
            assert.strictEqual(value, 'payload');
          });

          call.on('status', status => {
            assert.strictEqual(status.code, grpc.status.OK);
            assert.strictEqual(pool.channelRefs.length, 1);
            assert.strictEqual(pool.channelRefs[0].affinityCount, 1);
            assert.strictEqual(pool.channelRefs[0].activeStreamsCount, 0);
          });

          call.on('end', () => {
            const deleteSessionRequest = {name: sessionName};
            client.deleteSession(deleteSessionRequest, err => {
              assert.ifError(err);
              assert.strictEqual(pool.channelRefs.length, 1);
              assert.strictEqual(pool.channelRefs[0].affinityCount, 0);
              assert.strictEqual(pool.channelRefs[0].activeStreamsCount, 0);
              done();
            });
          });
        });
      });

      it('Test concurrent streams watermark', done => {
        const watermark = 5;
        pool.maxConcurrentStreamsLowWatermark = watermark;

        const expectedNumChannels = 3;

        const createCallPromises = [];

        for (let i = 0; i < watermark * expectedNumChannels; i++) {
          const promise = new Promise((resolve, reject) => {
            const createSessionRequest = {database: _DATABASE};
            client.createSession(createSessionRequest, (err, session) => {
              if (err) {
                reject(err);
              } else {
                const executeSqlRequest = {
                  session: session.name,
                  sql: _TEST_SQL,
                };
                const call = client.executeStreamingSql(executeSqlRequest);

                resolve({
                  call: call,
                  sessionName: session.name,
                });
              }
            });
          });
          createCallPromises.push(promise);
        }

        Promise.all(createCallPromises)
          .then(
            results => {
              assert.strictEqual(
                pool.channelRefs.length,
                expectedNumChannels
              );
              assert.strictEqual(
                pool.channelRefs[0].affinityCount,
                watermark
              );
              assert.strictEqual(
                pool.channelRefs[0].activeStreamsCount,
                watermark
              );

              // Consume streaming calls.
              const emitterPromises = results.map(
                result =>
                  new Promise(resolve => {
                    result.call.on('data', partialResultSet => {
                      const value = partialResultSet.values[0].stringValue;
                      assert.strictEqual(value, 'payload');
                    });
                    result.call.on('end', () => {
                      const deleteSessionRequest = {name: result.sessionName};
                      client.deleteSession(deleteSessionRequest, err => {
                        assert.ifError(err);
                        resolve();
                      });
                    });
                  })
              );

              // Make sure all sessions get cleaned.
              return Promise.all(emitterPromises);
            },
            error => {
              done(error);
            }
          )
          .then(
            () => {
              assert.strictEqual(
                pool.channelRefs.length,
                expectedNumChannels
              );
              assert.strictEqual(pool.channelRefs[0].affinityCount, 0);
              assert.strictEqual(pool.channelRefs[0].activeStreamsCount, 0);
              done();
            },
            error => {
              done(error);
            }
          );
      });

      it('Test invalid BOUND affinity', done => {
        const getSessionRequest = {name: 'wrong_name'};
        client.getSession(getSessionRequest, err => {
          assert(err);
          assert.strictEqual(
            err.message,
            '3 INVALID_ARGUMENT: Invalid GetSession request.'
          );
          done();
        });
      });

      it('Test invalid UNBIND affinity', done => {
        const deleteSessionRequest = {name: 'wrong_name'};
        client.deleteSession(deleteSessionRequest, err => {
          assert(err);
          assert.strictEqual(
            err.message,
            '3 INVALID_ARGUMENT: Invalid DeleteSession request.'
          );
          done();
        });
      });
    });

    describe('SpannerClient generated by google-gax', () => {
      const gaxGrpc = new gax.GrpcClient({grpc});
      const protos = gaxGrpc.loadProto(
        PROTO_DIR,
        'google/spanner/v1/spanner.proto'
      );
      const SpannerClient = protos.google.spanner.v1.Spanner;

      let client;
      let pool;

      beforeEach(async () => {
        const authFactory = new GoogleAuth({
          scopes: [_OAUTH_SCOPE],
        });
        const auth = await authFactory.getClient();

        const sslCreds = grpc.credentials.createSsl();
        const callCreds = grpc.credentials.createFromGoogleCredential(auth);
        const channelCreds = grpc.credentials.combineChannelCredentials(
          sslCreds,
          callCreds
        );

        const apiDefinition = JSON.parse(fs.readFileSync(_CONFIG_FILE));
        const apiConfig = grpcGcp.createGcpApiConfig(apiDefinition);

        const channelOptions = {
          channelFactoryOverride: grpcGcp.gcpChannelFactoryOverride,
          callInvocationTransformer: grpcGcp.gcpCallInvocationTransformer,
          gcpApiConfig: apiConfig,
        };

        client = new SpannerClient(_TARGET, channelCreds, channelOptions);
        pool = client.getChannel();
      });

      it('Test session operations', done => {
        client.createSession({database: _DATABASE}, (err, session) => {
          assert.ifError(err);
          const sessionName = session.name;

          client.getSession({name: sessionName}, (err, sessionResult) => {
            assert.ifError(err);
            assert.strictEqual(sessionResult.name, sessionName);

            client.listSessions({database: _DATABASE}, (err, response) => {
              assert.ifError(err);
              const sessionsList = response.sessions;
              const sessionNames = sessionsList.map(session => session.name);
              assert(sessionNames.includes(sessionName));

              client.deleteSession({name: sessionName}, err => {
                assert.ifError(err);
                done();
              });
            });
          });
        });
      });

      it('Test executeSql', done => {
        client.createSession({database: _DATABASE}, (err, session) => {
          assert.ifError(err);
          const sessionName = session.name;

          assert.strictEqual(pool.channelRefs.length, 1);
          assert.strictEqual(pool.channelRefs[0].affinityCount, 1);
          assert.strictEqual(pool.channelRefs[0].activeStreamsCount, 0);

          const executeSqlRequest = {
            session: sessionName,
            sql: _TEST_SQL,
          };
          client.executeSql(executeSqlRequest, (err, resultSet) => {
            assert.ifError(err);
            assert.notStrictEqual(resultSet, null);
            const rowsList = resultSet.rows;
            const value = rowsList[0].values[0].stringValue;

            assert.strictEqual(value, 'payload');
            assert.strictEqual(pool.channelRefs.length, 1);
            assert.strictEqual(pool.channelRefs[0].affinityCount, 1);
            assert.strictEqual(pool.channelRefs[0].activeStreamsCount, 0);

            const deleteSessionRequest = {name: sessionName};
            client.deleteSession(deleteSessionRequest, err => {
              assert.ifError(err);
              assert.strictEqual(pool.channelRefs.length, 1);
              assert.strictEqual(pool.channelRefs[0].affinityCount, 0);
              assert.strictEqual(pool.channelRefs[0].activeStreamsCount, 0);
              done();
            });
          });
        });
      });

      it('Test executeStreamingSql', done => {
        client.createSession({database: _DATABASE}, (err, session) => {
          assert.ifError(err);
          const sessionName = session.name;

          assert.strictEqual(pool.channelRefs.length, 1);
          assert.strictEqual(pool.channelRefs[0].affinityCount, 1);
          assert.strictEqual(pool.channelRefs[0].activeStreamsCount, 0);

          const executeSqlRequest = {
            session: sessionName,
            sql: _TEST_SQL,
          };
          const call = client.executeStreamingSql(executeSqlRequest);

          assert.strictEqual(pool.channelRefs.length, 1);
          assert.strictEqual(pool.channelRefs[0].affinityCount, 1);
          assert.strictEqual(pool.channelRefs[0].activeStreamsCount, 1);

          call.on('data', partialResultSet => {
            const value = partialResultSet.values[0].stringValue;
            assert.strictEqual(value, 'payload');
          });

          call.on('status', status => {
            assert.strictEqual(status.code, grpc.status.OK);
            assert.strictEqual(pool.channelRefs.length, 1);
            assert.strictEqual(pool.channelRefs[0].affinityCount, 1);
            assert.strictEqual(pool.channelRefs[0].activeStreamsCount, 0);
          });

          call.on('end', () => {
            client.deleteSession({name: sessionName}, err => {
              assert.ifError(err);
              assert.strictEqual(pool.channelRefs.length, 1);
              assert.strictEqual(pool.channelRefs[0].affinityCount, 0);
              assert.strictEqual(pool.channelRefs[0].activeStreamsCount, 0);
              done();
            });
          });
        });
      });
    });
  });
});
