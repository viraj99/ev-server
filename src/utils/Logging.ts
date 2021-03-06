import { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';
import { Log, LogLevel, LogType } from '../types/Log';
import { NextFunction, Request, Response } from 'express';

import { ActionsResponse } from '../types/GlobalType';
import AppAuthError from '../exception/AppAuthError';
import AppError from '../exception/AppError';
import BackendError from '../exception/BackendError';
import CFLog from 'cf-nodejs-logging-support';
import Configuration from '../utils/Configuration';
import Constants from './Constants';
import { HTTPError } from '../types/HTTPError';
import LoggingConfiguration from '../types/configuration/LoggingConfiguration';
import LoggingStorage from '../storage/mongodb/LoggingStorage';
import { OCPIResult } from '../types/ocpi/OCPIResult';
import { OCPPStatus } from '../types/ocpp/OCPPClient';
import { ServerAction } from '../types/Server';
import User from '../types/User';
import UserToken from '../types/UserToken';
import Utils from './Utils';
import cluster from 'cluster';
import sizeof from 'object-sizeof';

const MODULE_NAME = 'Logging';

export default class Logging {
  private static traceCalls: { [key: string]: number } = {};
  private static loggingConfig: LoggingConfiguration;

  public static getConfiguration(): LoggingConfiguration {
    if (!this.loggingConfig) {
      this.loggingConfig = Configuration.getLoggingConfig();
    }
    return this.loggingConfig;
  }

  // Debug DB
  public static traceStart(tenantID: string, module: string, method: string): string {
    if (Utils.isDevelopmentEnv()) {
      const key = `${tenantID}~${module}~${method}~${Utils.generateUUID()}`;
      Logging.traceCalls[key] = new Date().getTime();
      return key;
    }
  }

  // Debug DB
  public static traceEnd(tenantID: string, module: string, method: string, key: string, data: any = {}): void {
    if (Utils.isDevelopmentEnv()) {
      // Compute duration if provided
      let executionDurationMillis: number;
      let found = false;
      if (Logging.traceCalls[key]) {
        executionDurationMillis = (new Date().getTime() - Logging.traceCalls[key]);
        delete Logging.traceCalls[key];
        found = true;
      }
      const sizeOfDataKB = Utils.truncTo(sizeof(data) / 1024, 2);
      const numberOfRecords = Array.isArray(data) ? data.length : 0;
      console.debug(`${module}.${method} ${found ? '- ' + executionDurationMillis.toString() + 'ms' : ''}${!Utils.isEmptyJSon(data) ? '- ' + sizeOfDataKB.toString() + 'kB' : ''} ${Array.isArray(data) ? '- ' + numberOfRecords.toString() + 'rec' : ''}`);
      if (sizeOfDataKB > Constants.PERF_MAX_DATA_VOLUME_KB) {
        console.warn('====================================');
        console.warn(new Error(`Tenant ID '${tenantID}': Data must be < ${Constants.PERF_MAX_DATA_VOLUME_KB}kB, got ${sizeOfDataKB}kB`));
        console.warn('====================================');
      }
      if (executionDurationMillis > Constants.PERF_MAX_RESPONSE_TIME_MILLIS) {
        console.warn('====================================');
        console.warn(new Error(`Tenant ID '${tenantID}': Execution must be < ${Constants.PERF_MAX_RESPONSE_TIME_MILLIS}ms, got ${executionDurationMillis}ms`));
        console.warn('====================================');
      }
    }
  }

  // Log Debug
  public static async logDebug(log: Log): Promise<string> {
    log.level = LogLevel.DEBUG;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    return Logging._log(log);
  }

  // Log Security Debug
  public static async logSecurityDebug(log: Log): Promise<string> {
    log.type = LogType.SECURITY;
    return Logging.logDebug(log);
  }

  // Log Info
  public static async logInfo(log: Log): Promise<string> {
    log.level = LogLevel.INFO;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    return Logging._log(log);
  }

  // Log Security Info
  public static async logSecurityInfo(log: Log): Promise<string> {
    log.type = LogType.SECURITY;
    return Logging.logInfo(log);
  }

  // Log Warning
  public static async logWarning(log: Log): Promise<string> {
    log.level = LogLevel.WARNING;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    return Logging._log(log);
  }

  // Log Security Warning
  public static async logSecurityWarning(log: Log): Promise<string> {
    log.type = LogType.SECURITY;
    return Logging.logWarning(log);
  }

  // Log Error
  public static async logError(log: Log): Promise<string> {
    log.level = LogLevel.ERROR;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    return Logging._log(log);
  }

  // Log Security Error
  public static async logSecurityError(log: Log): Promise<string> {
    log.type = LogType.SECURITY;
    return Logging.logError(log);
  }

  public static async logExpressRequest(tenantID: string, decodedToken, req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Check perfs
      req['timestamp'] = new Date();
      // Log
      Logging.logSecurityDebug({
        tenantID,
        action: ServerAction.HTTP_REQUEST,
        user: (Utils.objectHasProperty(decodedToken, 'id') ? decodedToken as UserToken : null),
        message: `Express HTTP Request << ${req.method} '${req.url}'`,
        module: MODULE_NAME, method: 'logExpressRequest',
        detailedMessages: {
          url: req.url,
          method: req.method,
          query: Utils.cloneObject(req.query),
          body: Utils.cloneObject(req.body),
          locale: req.locale,
          xhr: req.xhr,
          ip: req.ip,
          ips: req.ips,
          httpVersion: req.httpVersion,
          headers: req.headers,
        }
      });
    } finally {
      next();
    }
  }

  public static logActionsResponse(
    tenantID: string, action: ServerAction, module: string, method: string, actionsResponse: ActionsResponse,
    messageSuccess: string, messageError: string, messageSuccessAndError: string,
    messageNoSuccessNoError: string): void {
    // Replace
    messageSuccess = messageSuccess.replace('{{inSuccess}}', actionsResponse.inSuccess.toString());
    messageError = messageError.replace('{{inError}}', actionsResponse.inError.toString());
    messageSuccessAndError = messageSuccessAndError.replace('{{inSuccess}}', actionsResponse.inSuccess.toString());
    messageSuccessAndError = messageSuccessAndError.replace('{{inError}}', actionsResponse.inError.toString());
    // Success and Error
    if (actionsResponse.inSuccess > 0 && actionsResponse.inError > 0) {
      Logging.logError({
        tenantID: tenantID,
        source: Constants.CENTRAL_SERVER,
        action, module, method,
        message: messageSuccessAndError
      });
    } else if (actionsResponse.inSuccess > 0) {
      Logging.logInfo({
        tenantID: tenantID,
        source: Constants.CENTRAL_SERVER,
        action, module, method,
        message: messageSuccess
      });
    } else if (actionsResponse.inError > 0) {
      Logging.logError({
        tenantID: tenantID,
        source: Constants.CENTRAL_SERVER,
        action, module, method,
        message: messageError
      });
    } else {
      Logging.logInfo({
        tenantID: tenantID,
        source: Constants.CENTRAL_SERVER,
        action, module, method,
        message: messageNoSuccessNoError
      });
    }
  }

  public static logOcpiResult(
    tenantID: string, action: ServerAction, module: string, method: string, ocpiResult: OCPIResult,
    messageSuccess: string, messageError: string, messageSuccessAndError: string,
    messageNoSuccessNoError: string): void {
    // Replace
    messageSuccess = messageSuccess.replace('{{inSuccess}}', ocpiResult.success.toString());
    messageError = messageError.replace('{{inError}}', ocpiResult.failure.toString());
    messageSuccessAndError = messageSuccessAndError.replace('{{inSuccess}}', ocpiResult.success.toString());
    messageSuccessAndError = messageSuccessAndError.replace('{{inError}}', ocpiResult.failure.toString());
    if (Utils.isEmptyArray(ocpiResult.logs)) {
      ocpiResult.logs = null;
    }
    // Success and Error
    if (ocpiResult.success > 0 && ocpiResult.failure > 0) {
      Logging.logError({
        tenantID: tenantID,
        source: Constants.CENTRAL_SERVER,
        action, module, method,
        message: messageSuccessAndError,
        detailedMessages: ocpiResult.logs
      });
    } else if (ocpiResult.success > 0) {
      Logging.logInfo({
        tenantID: tenantID,
        source: Constants.CENTRAL_SERVER,
        action, module, method,
        message: messageSuccess,
        detailedMessages: ocpiResult.logs
      });
    } else if (ocpiResult.failure > 0) {
      Logging.logError({
        tenantID: tenantID,
        source: Constants.CENTRAL_SERVER,
        action, module, method,
        message: messageError,
        detailedMessages: ocpiResult.logs
      });
    } else {
      Logging.logInfo({
        tenantID: tenantID,
        source: Constants.CENTRAL_SERVER,
        action, module, method,
        message: messageNoSuccessNoError,
        detailedMessages: ocpiResult.logs
      });
    }
  }

  public static logExpressResponse(req: Request, res: Response, next: NextFunction): void {
    res.on('finish', () => {
      try {
        // Retrieve Tenant ID if available
        let tenantID: string;
        if (req['tenantID']) {
          tenantID = req['tenantID'];
        }
        // Compute duration
        let executionDurationMillis = 0;
        if (req['timestamp']) {
          executionDurationMillis = (new Date().getTime() - req['timestamp'].getTime());
        }
        // Compute Length
        let sizeOfDataKB = 0;
        if (res.getHeader('content-length')) {
          sizeOfDataKB = Utils.truncTo(res.getHeader('content-length') as number / 1024, 2);
        }
        if (Utils.isDevelopmentEnv()) {
          console.debug(`Express HTTP Response - ${(executionDurationMillis > 0) ? executionDurationMillis : '?'}ms - ${(sizeOfDataKB > 0) ? sizeOfDataKB : '?'}kB >> ${req.method}/${res.statusCode} '${req.url}'`);
          if (sizeOfDataKB > Constants.PERF_MAX_DATA_VOLUME_KB) {
            console.warn('====================================');
            console.warn(new Error(`Tenant ID '${tenantID}': Data must be < ${Constants.PERF_MAX_DATA_VOLUME_KB}kB, got ${(sizeOfDataKB > 0) ? sizeOfDataKB : '?'}kB`));
            console.warn('====================================');
          }
          if (executionDurationMillis > Constants.PERF_MAX_RESPONSE_TIME_MILLIS) {
            console.warn('====================================');
            console.warn(new Error(`Tenant ID '${tenantID}': Execution must be < ${Constants.PERF_MAX_RESPONSE_TIME_MILLIS}ms, got ${(executionDurationMillis > 0) ? executionDurationMillis : '?'}ms`));
            console.warn('====================================');
          }
        }
        Logging.logSecurityDebug({
          tenantID: tenantID,
          user: req.user,
          action: ServerAction.HTTP_RESPONSE,
          message: `Express HTTP Response - ${(executionDurationMillis > 0) ? executionDurationMillis : '?'}ms - ${(sizeOfDataKB > 0) ? sizeOfDataKB : '?'}kB >> ${req.method}/${res.statusCode} '${req.url}'`,
          module: MODULE_NAME, method: 'logExpressResponse',
          detailedMessages: {
            request: req.url,
            status: res.statusCode,
            statusMessage: res.statusMessage,
            headers: res.getHeaders(),
          }
        });
      } finally {
        next();
      }
    });
  }

  public static logExpressError(error: Error, req: Request, res: Response, next: NextFunction): void {
    Logging.logActionExceptionMessageAndSendResponse(
      error['params'] && error['params']['action'] ? error['params']['action'] : ServerAction.HTTP_ERROR, error, req, res, next);
  }

  public static logAxiosRequest(tenantID: string, request: AxiosRequestConfig): void {
    request['timestamp'] = new Date();
    Logging.logSecurityDebug({
      tenantID: tenantID,
      action: ServerAction.HTTP_REQUEST,
      message: `Axios HTTP Request >> ${request.method.toLocaleUpperCase()} '${request.url}'`,
      module: MODULE_NAME, method: 'interceptor',
      detailedMessages: {
        request: Utils.cloneObject(request),
      }
    });
  }

  public static logAxiosResponse(tenantID: string, response: AxiosResponse): void {
    // Compute duration
    let executionDurationMillis: number;
    if (response.config['timestamp']) {
      executionDurationMillis = (new Date().getTime() - response.config['timestamp'].getTime());
    }
    // Compute Length
    let sizeOfDataKB = 0;
    if (response.config.headers['Content-Length']) {
      sizeOfDataKB = Utils.truncTo(response.config.headers['Content-Length'] / 1024, 2);
    }
    if (Utils.isDevelopmentEnv()) {
      console.log(`Axios HTTP Response - ${(executionDurationMillis > 0) ? executionDurationMillis : '?'}ms - ${(sizeOfDataKB > 0) ? sizeOfDataKB : '?'}kB << ${response.config.method.toLocaleUpperCase()}/${response.status} '${response.config.url}'`);
      if (sizeOfDataKB > Constants.PERF_MAX_DATA_VOLUME_KB) {
        console.warn('====================================');
        console.warn(new Error(`Tenant ID '${tenantID}': Data must be < ${Constants.PERF_MAX_DATA_VOLUME_KB}`));
        console.warn('====================================');
      }
      if (executionDurationMillis > Constants.PERF_MAX_RESPONSE_TIME_MILLIS) {
        console.warn('====================================');
        console.warn(new Error(`Tenant ID '${tenantID}': Execution must be < ${Constants.PERF_MAX_RESPONSE_TIME_MILLIS}ms, got ${(executionDurationMillis > 0) ? executionDurationMillis : '?'}ms`));
        console.warn('====================================');
      }
    }
    Logging.logSecurityDebug({
      tenantID: tenantID,
      action: ServerAction.HTTP_RESPONSE,
      message: `Axios HTTP Response - ${(executionDurationMillis > 0) ? executionDurationMillis : '?'}ms - ${(sizeOfDataKB > 0) ? sizeOfDataKB : '?'}kB << ${response.config.method.toLocaleUpperCase()}/${response.status} '${response.config.url}'`,
      module: MODULE_NAME, method: 'interceptor',
      detailedMessages: {
        status: response.status,
        statusText: response.statusText,
        request: Utils.cloneObject(response.config),
        headers: Utils.cloneObject(response.headers),
        response: Utils.cloneObject(response.data)
      }
    });
  }

  public static logAxiosError(tenantID: string, error: AxiosError): void {
    // Error handling is done outside to get the proper module information
    Logging.logSecurityError({
      tenantID: tenantID,
      action: ServerAction.HTTP_ERROR,
      message: `Axios HTTP Error >> ${error.config?.method?.toLocaleUpperCase()}/${error.response?.status} '${error.config?.url}' - ${error.message}`,
      module: MODULE_NAME, method: 'interceptor',
      detailedMessages: {
        url: error.config?.url,
        status: error.response?.status,
        statusText: error.response?.statusText,
        message: error.message,
        response: error.response?.data,
        axiosError: Utils.objectHasProperty(error, 'toJSON') ? error.toJSON() : null,
      }
    });
  }

  public static logChargingStationClientSendAction(module: string, tenantID: string, chargeBoxID: string,
    action: ServerAction, args: any): void {
    this.traceChargingStationActionStart(module, tenantID,chargeBoxID, action, args, '<<');
  }

  public static logChargingStationClientReceiveAction(module: string, tenantID: string, chargeBoxID: string,
    action: ServerAction, detailedMessages: any): void {
    this.traceChargingStationActionEnd(module, tenantID, chargeBoxID, action, detailedMessages, '>>');
  }

  public static logChargingStationServerReceiveAction(module: string, tenantID: string, chargeBoxID: string,
    action: ServerAction, payload: any): void {
    this.traceChargingStationActionStart(module, tenantID,chargeBoxID, action, payload, '>>');
  }

  public static logChargingStationServerRespondAction(module: string, tenantID: string, chargeBoxID: string,
    action: ServerAction, detailedMessages: any): void {
    this.traceChargingStationActionEnd(module, tenantID, chargeBoxID, action, detailedMessages, '<<');
  }

  // Used to log exception in catch(...) only
  public static logException(error: Error, action: ServerAction, source: string, module: string, method: string, tenantID: string, user?: UserToken|User|string): void {
    const log: Log = Logging._buildLog(error, action, source, module, method, tenantID, user);
    if (error instanceof AppAuthError) {
      Logging.logSecurityError(log);
    } else if (error instanceof AppError) {
      Logging.logError(log);
    } else if (error instanceof BackendError) {
      Logging.logError(log);
    } else {
      Logging.logError(log);
    }
  }

  // Used to log exception in catch(...) only
  public static logActionExceptionMessage(tenantID: string, action: ServerAction, exception: Error): void {
    // Log App Error
    if (exception instanceof AppError) {
      Logging._logActionAppExceptionMessage(tenantID, action, exception);
    // Log Backend Error
    } else if (exception instanceof BackendError) {
      Logging._logActionBackendExceptionMessage(tenantID, action, exception);
    // Log Auth Error
    } else if (exception instanceof AppAuthError) {
      Logging._logActionAppAuthExceptionMessage(tenantID, action, exception);
    } else {
      Logging._logActionExceptionMessage(tenantID, action, exception);
    }
  }

  // Used to log exception in catch(...) only
  public static logActionExceptionMessageAndSendResponse(action: ServerAction, exception: Error, req: Request, res: Response, next: NextFunction, tenantID = Constants.DEFAULT_TENANT): void {
    // Clear password
    if (action === ServerAction.LOGIN && req.body.password) {
      req.body.password = '####';
    }
    if (req.user && req.user.tenantID) {
      tenantID = req.user.tenantID;
    }
    let statusCode;
    // Log App Error
    if (exception instanceof AppError) {
      Logging._logActionAppExceptionMessage(tenantID, action, exception);
      statusCode = exception.params.errorCode;
    // Log Backend Error
    } else if (exception instanceof BackendError) {
      Logging._logActionBackendExceptionMessage(tenantID, action, exception);
      statusCode = HTTPError.GENERAL_ERROR;
    // Log Auth Error
    } else if (exception instanceof AppAuthError) {
      Logging._logActionAppAuthExceptionMessage(tenantID, action, exception);
      statusCode = exception.params.errorCode;
    } else {
      Logging._logActionExceptionMessage(tenantID, action, exception);
    }
    // Send error
    res.status(statusCode ? statusCode : HTTPError.GENERAL_ERROR).send({
      'message': Utils.hideShowMessage(exception.message)
    });
    next();
  }

  private static _logActionExceptionMessage(tenantID: string, action: ServerAction, exception: any): void {
    // Log
    Logging.logError({
      tenantID: tenantID,
      type: LogType.SECURITY,
      user: exception.user,
      source: exception.source,
      module: exception.module,
      method: exception.method,
      action: action,
      message: exception.message,
      detailedMessages: { stack: exception.stack }
    });
  }

  private static _logActionAppExceptionMessage(tenantID: string, action: ServerAction, exception: AppError): void {
    // Add Exception stack
    if (exception.params.detailedMessages) {
      exception.params.detailedMessages = {
        'stack': exception.stack,
        'previous' : exception.params.detailedMessages
      };
    } else {
      exception.params.detailedMessages = {
        'stack': exception.stack,
      };
    }
    // Log
    Logging.logError({
      tenantID: tenantID,
      type: LogType.SECURITY,
      source: exception.params.source,
      user: exception.params.user,
      actionOnUser: exception.params.actionOnUser,
      module: exception.params.module,
      method: exception.params.method,
      action: action,
      message: exception.message,
      detailedMessages: exception.params.detailedMessages
    });
  }

  private static _logActionBackendExceptionMessage(tenantID: string, action: ServerAction, exception: BackendError): void {
    // Add Exception stack
    if (exception.params.detailedMessages) {
      exception.params.detailedMessages = {
        'stack': exception.stack,
        'previous' : exception.params.detailedMessages
      };
    } else {
      exception.params.detailedMessages = {
        'stack': exception.stack,
      };
    }
    // Log
    Logging.logError({
      tenantID: tenantID,
      type: LogType.SECURITY,
      source: exception.params.source,
      module: exception.params.module,
      method: exception.params.method,
      action: action,
      message: exception.message,
      user: exception.params.user,
      actionOnUser: exception.params.actionOnUser,
      detailedMessages: exception.params.detailedMessages
    });
  }

  // Used to check URL params (not in catch)
  private static _logActionAppAuthExceptionMessage(tenantID: string, action: ServerAction, exception: AppAuthError): void {
    // Log
    Logging.logSecurityError({
      tenantID: tenantID,
      type: LogType.SECURITY,
      user: exception.params.user,
      actionOnUser: exception.params.actionOnUser,
      module: exception.params.module,
      method: exception.params.method,
      action: action,
      message: exception.message,
      detailedMessages: [{
        'stack': exception.stack
      }]
    });
  }

  private static _buildLog(error, action: ServerAction, source: string, module: string,
    method: string, tenantID: string, user: UserToken|User|string): Log {
    const tenant = tenantID ? tenantID : Constants.DEFAULT_TENANT;
    if (error.params) {
      return {
        source: source,
        user: user,
        tenantID: tenant,
        actionOnUser: error.params.actionOnUser,
        module: module,
        method: method,
        action: action,
        message: error.message,
        detailedMessages: [{
          'details': error.params.detailedMessages,
          'stack': error.stack
        }]
      };
    }
    return {
      source: source,
      user: user,
      tenantID: tenant,
      actionOnUser: error.actionOnUser,
      module: module,
      method: method,
      action: action,
      message: error.message,
      detailedMessages: [{
        'details': error.detailedMessages,
        'stack': error.stack
      }]
    };
  }

  // Used to check URL params (not in catch)
  private static _format(detailedMessage: any): string {
    // JSON?
    if (typeof detailedMessage === 'object') {
      try {
        // Check that every detailedMessages is parsed
        return JSON.stringify(detailedMessage, null, ' ');
      } catch (err) {
        return detailedMessage;
      }
    }
  }

  // Log
  private static async _log(log: Log): Promise<string> {
    let moduleConfig = null;
    const loggingConfig = Logging.getConfiguration();
    // Default Log Level
    let logLevel = loggingConfig.logLevel ? loggingConfig.logLevel : LogLevel.DEBUG;
    // Default Console Level
    let consoleLogLevel = loggingConfig.consoleLogLevel ? loggingConfig.consoleLogLevel : LogLevel.NONE;
    // Module Provided?
    if (log.module && loggingConfig.moduleDetails) {
      // Yes: Check the Module
      if (loggingConfig.moduleDetails[log.module]) {
        // Get Modules Config
        moduleConfig = loggingConfig.moduleDetails[log.module];
        // Check Module Log Level
        if (moduleConfig.logLevel) {
          if (moduleConfig.logLevel !== LogLevel.DEFAULT) {
            logLevel = moduleConfig.logLevel;
          }
        }
        // Check Console Log Level
        if (moduleConfig.consoleLogLevel) {
          // Default?
          if (moduleConfig.consoleLogLevel !== LogLevel.DEFAULT) {
            // No
            consoleLogLevel = moduleConfig.consoleLogLevel;
          }
        }
      }
    }
    // Log Level takes precedence over console log
    switch (LogLevel[consoleLogLevel]) {
      case LogLevel.NONE:
        break;
      // Keep up to error filter out debug
      case LogLevel.ERROR:
        if (log.level === LogLevel.INFO || log.level === LogLevel.WARNING || log.level === LogLevel.DEBUG) {
          break;
        }
      // Keep up to warning filter out debug
      case LogLevel.WARNING: // eslint-disable-line no-fallthrough
        if (log.level === LogLevel.INFO || log.level === LogLevel.DEBUG) {
          break;
        }
      // Keep all log messages just filter out DEBUG
      case LogLevel.INFO: // eslint-disable-line no-fallthrough
        if (log.level === LogLevel.DEBUG) {
          break;
        }
      // Keep all messages
      case LogLevel.DEBUG: // eslint-disable-line no-fallthrough
      default: // If we did not break then it means we have to console log it
        Logging._consoleLog(log);
        break;
    }
    // Do not log to DB simple string messages
    if (log['simpleMessage']) {
      return;
    }
    // Log Level
    switch (LogLevel[logLevel]) {
      // No logging at all
      case LogLevel.NONE:
        return;
      // Keep all log messages just filter out DEBUG
      case LogLevel.INFO:
        if (log.level === LogLevel.DEBUG) {
          return;
        }
        break;
      // Keep up to warning filter out debug
      case LogLevel.WARNING:
        if (log.level === LogLevel.INFO || log.level === LogLevel.DEBUG) {
          return;
        }
        break;
      // Keep up to error filter out debug
      case LogLevel.ERROR:
        if (log.level === LogLevel.INFO || log.level === LogLevel.WARNING || log.level === LogLevel.DEBUG) {
          return;
        }
        break;
      // Keep ALL
      case LogLevel.DEBUG:
      default:
        break;
    }
    // Timestamp
    log.timestamp = new Date();
    // Source
    if (!log.source) {
      log.source = `${Constants.CENTRAL_SERVER}`;
    }
    // Host
    log.host = Utils.getHostname();
    // Process
    log.process = log.process ? log.process : (cluster.isWorker ? 'worker ' + cluster.worker.id.toString() : 'master');
    // Check
    if (log.detailedMessages) {
      // Anonymize message
      log.detailedMessages = Utils.cloneObject(log.detailedMessages);
      log.detailedMessages = Logging.anonymizeSensitiveData(log.detailedMessages);
      // Array?
      if (!Array.isArray(log.detailedMessages)) {
        log.detailedMessages = [log.detailedMessages];
      }
      // Format
      log.detailedMessages = Logging._format(log.detailedMessages);
    }
    // Check Type
    if (!log.type) {
      log.type = LogType.REGULAR;
    }
    // First char always in Uppercase
    if (typeof log.message === 'string' && log.message && log.message.length > 0) {
      log.message = log.message[0].toUpperCase() + log.message.substring(1);
    }
    if (!log.tenantID || log.tenantID === '') {
      log.tenantID = Constants.DEFAULT_TENANT;
    }

    // Log in Cloud Foundry
    if (Configuration.isCloudFoundry()) {
      // Bind to express app
      CFLog.logMessage(Logging.getCFLogLevel(log.level), log.message);
    }

    // Log
    return LoggingStorage.saveLog(log.tenantID, log);
  }

  private static anonymizeSensitiveData(message: any): any {
    if (!message || typeof message === 'number' || Utils.isBoolean(message) || typeof message === 'function') {
      return message;
    } else if (typeof message === 'string') { // If the message is a string
      // Check if it is a query string
      const dataParts: string[] = message.split('&');
      if (dataParts.length > 1) {
        for (let i = 0; i < dataParts.length; i++) {
          const dataPart = dataParts[i];
          for (const sensitiveData of Constants.SENSITIVE_DATA) {
            if (dataPart.toLowerCase().startsWith(sensitiveData.toLocaleLowerCase())) {
              // Anonymize each query string part
              dataParts[i] = dataPart.substring(0, sensitiveData.length + 1) + Constants.ANONYMIZED_VALUE;
            }
          }
        }
        message = dataParts.join('&');
        return message;
      }
      // Check if the message is a string which contains sensitive data
      for (const sensitiveData of Constants.SENSITIVE_DATA) {
        if (message.toLowerCase().indexOf(sensitiveData.toLowerCase()) !== -1) {
          // Anonymize the whole message
          return Constants.ANONYMIZED_VALUE;
        }
      }
      return message;
    } else if (Array.isArray(message)) { // If the message is an array, apply the anonymizeSensitiveData function for each item
      const anonymizedMessage = [];
      for (const item of message) {
        anonymizedMessage.push(Logging.anonymizeSensitiveData(item));
      }
      return anonymizedMessage;
    } else if (typeof message === 'object') { // If the message is an object
      for (const key of Object.keys(message)) {
        if (typeof message[key] === 'string' && Constants.SENSITIVE_DATA.filter((sensitiveData) => key.toLocaleLowerCase() === sensitiveData.toLocaleLowerCase()).length > 0) {
          // If the key indicates sensitive data and the value is a string, Anonymize the value
          message[key] = Constants.ANONYMIZED_VALUE;
        } else { // Otherwise, apply the anonymizeSensitiveData function
          message[key] = Logging.anonymizeSensitiveData(message[key]);
        }
      }
      return message;
    }
    // Log
    Logging.logError({
      tenantID: Constants.DEFAULT_TENANT,
      type: LogType.SECURITY,
      module: MODULE_NAME,
      method: 'anonymizeSensitiveData',
      action: ServerAction.LOGGING,
      message: 'No matching object type for log message anonymisation',
      detailedMessages: { message: message }
    });
  }

  // Console Log
  private static _consoleLog(log): void {
    let logFn;
    // Set the function to log
    switch (log.level) {
      case LogLevel.DEBUG:
        // eslint-disable-next-line no-console
        logFn = console.debug;
        break;
      case LogLevel.ERROR:
        // eslint-disable-next-line no-console
        logFn = console.error;
        break;
      case LogLevel.WARNING:
        // eslint-disable-next-line no-console
        logFn = console.warn;
        break;
      case LogLevel.INFO:
        // eslint-disable-next-line no-console
        logFn = console.info;
        break;
      default:
        // eslint-disable-next-line no-console
        logFn = console.log;
        break;
    }

    // Log
    log.timestamp = new Date();
    if (log.simpleMessage) {
      logFn(log.timestamp.toISOString() + ' ' + log.simpleMessage);
    } else {
      logFn(log);
    }
  }

  // Log
  private static getCFLogLevel(logLevel): string {
    // Log level
    switch (logLevel) {
      case LogLevel.DEBUG:
        return 'debug';
      case LogLevel.INFO:
        return 'info';
      case LogLevel.WARNING:
        return 'warning';
      case LogLevel.ERROR:
        return 'error';
    }
  }

  private static traceChargingStationActionStart(module: string, tenantID: string, chargeBoxID: string,
    action: ServerAction, args: any, direction: '<<'|'>>'): void {
    // Keep duration
    Logging.traceCalls[`${chargeBoxID}~action`] = new Date().getTime();
    // Log
    Logging.logDebug({
      tenantID: tenantID,
      source: chargeBoxID,
      module: module, method: action,
      message: `${direction} OCPP Request '${action}' ${direction === '>>' ? 'received' : 'sent'}`,
      action: action,
      detailedMessages: { args }
    });
  }

  private static traceChargingStationActionEnd(module: string, tenantID: string, chargeBoxID: string, action: ServerAction, detailedMessages: any, direction: '<<'|'>>'): void {
    // Compute duration if provided
    let executionDurationMillis: number;
    let found = false;
    if (Logging.traceCalls[`${chargeBoxID}~action`]) {
      executionDurationMillis = (new Date().getTime() - Logging.traceCalls[`${chargeBoxID}~action`]);
      delete Logging.traceCalls[`${chargeBoxID}~action`];
      found = true;
    }
    if (Utils.isDevelopmentEnv()) {
      console.debug(`${direction} OCPP Request '${action}' on '${chargeBoxID}' has been processed ${found ? 'in ' + executionDurationMillis.toString() + 'ms' : ''}`);
      if (executionDurationMillis > Constants.PERF_MAX_RESPONSE_TIME_MILLIS) {
        console.warn('====================================');
        console.warn(new Error(`Tenant ID '${tenantID}': Execution must be < ${Constants.PERF_MAX_RESPONSE_TIME_MILLIS}ms, got ${executionDurationMillis}ms`));
        console.warn('====================================');
      }
    }
    if (detailedMessages && detailedMessages['status'] && detailedMessages['status'] === OCPPStatus.REJECTED) {
      Logging.logError({
        tenantID: tenantID,
        source: chargeBoxID,
        module: module, method: action,
        message: `${direction} OCPP Request has been processed ${found ? 'in ' + executionDurationMillis.toString() + 'ms' : ''}`,
        action: action,
        detailedMessages
      });
    } else {
      Logging.logDebug({
        tenantID: tenantID,
        source: chargeBoxID,
        module: module, method: action,
        message: `${direction} OCPP Request has been processed ${found ? 'in ' + executionDurationMillis.toString() + 'ms' : ''}`,
        action: action,
        detailedMessages
      });
    }
  }
}
