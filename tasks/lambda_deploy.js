/*
 * grunt-aws-lambda
 * https://github.com/Tim-B/grunt-aws-lambda
 *
 * Copyright (c) 2014 Tim-B
 * Licensed under the MIT license.
 */

'use strict';

module.exports = function (grunt) {

  var path = require('path');
  var fs = require('fs');
  var AWS = require('aws-sdk');
  var arnParser = require('../utils/arn_parser');

  // Please see the Grunt documentation for more information regarding task
  // creation: http://gruntjs.com/creating-tasks

  grunt.registerMultiTask('lambda_deploy', 'Uploads a package to lambda',
    function () {

      grunt.config.requires('lambda_deploy.' + this.target + '.package');

      var options = this.options({
        profile: null,
        RoleArn: null,
        assumeRole: null,
        accessKeyId: null,
        secretAccessKey: null,
        credentialsJSON: null,
        region: 'us-east-1',
        timeout: null,
        memory: null,
        handler: null,
        role: null,
        alias: null
      });

      if (options.profile !== null) {
        var credentials = new AWS.SharedIniFileCredentials({
          profile: options.profile
        });
        AWS.config.credentials = credentials;
      }

      if (options.RoleArn !== null) {
        AWS.config.credentials = new AWS.EC2MetadataCredentials({
          httpOptions: {
            timeout: 5000
          } // 5 second timeout
        });
        AWS.config.credentials = new AWS.TemporaryCredentials({
          RoleArn: options.RoleArn
        });
      }

      if (options.accessKeyId !== null && options.secretAccessKey !== null) {
        AWS.config.update({
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey
        });
      }

      if (options.credentialsJSON !== null) {
        AWS.config.loadFromPath(options.credentialsJSON);
      }

      AWS.config.update({
        region: options.region
      });

      var deploy_function =
        grunt.config.get('lambda_deploy.' + this.target + '.function');
      var deploy_arn =
        grunt.config.get('lambda_deploy.' + this.target + '.arn');
      var deploy_package =
        grunt.config.get('lambda_deploy.' + this.target + '.package');

      if (deploy_arn === null && deploy_function === null) {
        grunt.fail.fatal(
          'You must specify either an arn or a function name.');
      }

      if (deploy_arn !== null) {
        deploy_function = deploy_arn;
        var functionInfo = arnParser.parse(deploy_arn);
        if (functionInfo && functionInfo.region) {
          options.region = functionInfo.region;
        }
      }

      var configureClient =
        function configureClientFn(assumeRole, callback) {
          var clientConfig = {
            apiVersion: '2015-03-31',
          };

          if (assumeRole) {
            var sts = new AWS.STS({
              apiVersion: '2011-06-15',
            });
            grunt.log.debug('Assuming role: ', assumeRole);
            sts.assumeRole(
              assumeRole,
              function (err, response) {
                if (err) {
                  callback(err);
                } else {
                  clientConfig.credentials = {
                    accessKeyId: response.Credentials.AccessKeyId,
                    secretAccessKey: response.Credentials.SecretAccessKey,
                    sessionToken: response.Credentials.SessionToken,
                    expireTime: response.Credentials.Expiration,
                  };
                  callback(null, clientConfig);
                }
              }
            );
          } else {
            callback(null, clientConfig);
          };
        }

      var done = this.async();

      configureClient(
        options.assumeRole,
        function (err, configResponse) {

          if (err) {
            grunt.log.error('Failed to assume role: ' + err.statusCode +
              ' - ' + err);
            grunt.fail.fatal(
              'Check your AWS credentials, region and permissions are correct.'
            );
          }

          AWS.config.update({
            region: options.region
          });
          var lambda = new AWS.Lambda(configResponse);

          lambda.getFunction({
            FunctionName: deploy_function
          }, function (err, data) {

            if (err) {
              if (err.statusCode === 404) {
                grunt.fail.fatal('Unable to find lambda function ' +
                  deploy_function +
                  ', verify the lambda function name and AWS region are correct.'
                );
              } else {
                grunt.log.error('AWS API request failed with ' + err.statusCode +
                  ' - ' + err);
                grunt.fail.fatal(
                  'Check your AWS credentials, region and permissions are correct.'
                );
              }
            }

            var current = data.Configuration;
            var configParams = {};
            var roleConfigParams = {
              Role: options.role
            };


            if (options.timeout !== null) {
              configParams.Timeout = options.timeout;
            }

            if (options.memory !== null) {
              configParams.MemorySize = options.memory;
            }

            if (options.handler !== null) {
              configParams.Handler = options.handler;
            }

            var updateConfig = function (func_name, func_options,
              callback) {
              if (Object.keys(func_options).length > 0) {
                func_options.FunctionName = func_name;
                lambda.updateFunctionConfiguration(func_options,
                  function (
                    err, data) {
                    if (err) {
                      grunt.fail.fatal(
                        'Could not update config: ' + err
                      );
                    }
                    grunt.log.writeln('Config updated.');
                    callback(data);
                  });
              } else {
                grunt.log.writeln('No config updates to make.');
                callback(false);
                return;
              }
            };

            var createOrUpdateAlias = function (fn, alias, version,
              callback) {
              lambda.getAlias({
                FunctionName: fn,
                Name: alias
              }, function (err, data) {
                if (err && err.statusCode !== 404) {
                  grunt.fail.fatal('Failed to get alias: ' +
                    err);
                }
                var operation;
                if (err) {
                  grunt.log.writeln(
                    'Alias ' + alias +
                    ' not found, creating.'
                  );
                  operation = 'createAlias';
                } else {
                  grunt.log.writeln(
                    'Alias ' + alias +
                    ' already exists, updating.'
                  );
                  operation = 'updateAlias';
                }
                lambda[operation]({
                  FunctionName: fn,
                  Name: alias,
                  FunctionVersion: version
                }, function (err, data) {
                  if (err) {
                    grunt.fail.fatal(
                      'Error from ' + operation + ': ' +
                      err
                    );
                  }
                  callback();
                });
              });
            };

            grunt.log.writeln('Uploading...');
            fs.readFile(deploy_package, function (err, data) {
              if (err) {
                grunt.fail.fatal(
                  'Could not read package file (' +
                  deploy_package +
                  '), verify the lambda package ' +
                  'location is correct, and that you have already ' +
                  'created the package using lambda_package.'
                );
              }

              var codeParams = {
                FunctionName: deploy_function,
                ZipFile: data
              };

              var publish = (options.alias != null);
              if (publish) {
                codeParams.Publish = true;
              }

              var finalDone = function () {
                done(true);
              };

              var updateCode = function () {
                lambda.updateFunctionCode(codeParams, function (
                  err,
                  data) {
                  if (err) {
                    grunt.fail.fatal(
                      'Package upload failed: ' +
                      err);
                  }
                  var version = data.Version;
                  grunt.log.writeln('Package deployed.');
                  updateConfig(
                    deploy_function,
                    configParams,
                    function () {
                      if (publish) {
                        grunt.log.writeln(
                          'Aliasing ' + options.alias +
                          ' to version ' + version +
                          '.'
                        );
                        createOrUpdateAlias(
                          deploy_function,
                          options.alias,
                          version,
                          finalDone
                        );
                      } else {
                        finalDone();
                      }
                    });
                });
              }

              if (options.role != null) {
                grunt.log.writeln(
                  'Setting function role to: ' + options.role
                );
                updateConfig(
                  deploy_function,
                  roleConfigParams,
                  updateCode
                );
              } else {
                updateCode();
              }
            });
          });
        }
      )
    });
};
