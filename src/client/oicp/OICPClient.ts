import { AxiosInstance, AxiosRequestConfig } from 'axios';

import AxiosFactory from '../../utils/AxiosFactory';
import BackendError from '../../exception/BackendError';
import Logging from '../../utils/Logging';
import OICPEndpoint from '../../types/oicp/OICPEndpoint';
import { OICPJobResult } from '../../types/oicp/OICPJobResult';
import { OICPOperatorID } from '../../types/oicp/OICPEvse';
import { OICPRole } from '../../types/oicp/OICPRole';
import { OicpSetting } from '../../types/Setting';
import { ServerAction } from '../../types/Server';
import Tenant from '../../types/Tenant';
import https from 'https';

const MODULE_NAME = 'OICPClient';

export default abstract class OICPClient {
  protected axiosInstance: AxiosInstance;
  protected oicpEndpoint: OICPEndpoint;
  protected tenant: Tenant;
  protected role: string;
  protected settings: OicpSetting;

  protected constructor(tenant: Tenant, settings: OicpSetting, oicpEndpoint: OICPEndpoint, role: string) {
    if (role !== OICPRole.CPO && role !== OICPRole.EMSP) {
      throw new BackendError({
        message: `Invalid OICP role '${role}'`,
        module: MODULE_NAME, method: 'constructor',
      });
    }
    this.tenant = tenant;
    this.settings = settings;
    this.oicpEndpoint = oicpEndpoint;
    this.role = role.toLowerCase();
    this.axiosInstance = AxiosFactory.getAxiosInstance(tenant.id, { axiosConfig: this.getAxiosConfig(ServerAction.OICP_CREATE_AXIOS_INSTANCE) });
  }

  getLocalCountryCode(action: ServerAction): string {
    if (!this.settings[this.role]) {
      throw new BackendError({
        action, message: `OICP Settings are missing for role ${this.role}`,
        module: MODULE_NAME, method: 'getLocalCountryCode',
      });
    }
    if (!this.settings[this.role].countryCode) {
      throw new BackendError({
        action, message: `OICP Country Code setting is missing for role ${this.role}`,
        module: MODULE_NAME, method: 'getLocalCountryCode',
      });
    }
    return this.settings[this.role].countryCode;
  }

  getLocalPartyID(action: ServerAction): string {
    if (!this.settings[this.role]) {
      throw new BackendError({
        action, message: `OICP Settings are missing for role ${this.role}`,
        module: MODULE_NAME, method: 'getLocalPartyID',
      });
    }
    if (!this.settings[this.role].partyID) {
      throw new BackendError({
        action, message: `OICP Party ID setting is missing for role ${this.role}`,
        module: MODULE_NAME, method: 'getLocalPartyID',
      });
    }
    return this.settings[this.role].partyID;
  }

  getOperatorID(action: ServerAction): OICPOperatorID {
    const countryCode = this.getLocalCountryCode(action);
    const partyID = this.getLocalPartyID(action);
    const operatorID = `${countryCode}*${partyID}`;
    return operatorID;
  }

  protected getEndpointUrl(service: string, action: ServerAction): string {
    if (this.oicpEndpoint.availableEndpoints) {
      const baseURL = this.oicpEndpoint.baseUrl;
      const path = this.oicpEndpoint.availableEndpoints[service].replace('{operatorID}', this.getOperatorID(action));
      const fullURL = baseURL.concat(path);
      return fullURL;
    }
    throw new BackendError({
      action, message: `No endpoint URL defined for service ${service}`,
      module: MODULE_NAME, method: 'getLocalPartyID',
    });
  }

  private getAxiosConfig(action: ServerAction): AxiosRequestConfig {
    const axiosConfig: AxiosRequestConfig = {} as AxiosRequestConfig;
    axiosConfig.httpsAgent = this.getHttpsAgent(action);
    axiosConfig.headers = {
      'Content-Type': 'application/json'
    };
    return axiosConfig;
  }

  private getPrivateKey(action: ServerAction): string {
    if (!this.settings[this.role]) {
      throw new BackendError({
        action, message: `OICP Settings are missing for role ${this.role}`,
        module: MODULE_NAME, method: 'getPrivateKey',
      });
    }
    if (!this.settings[this.role].privateKey) {
      throw new BackendError({
        action, message: `OICP private Key setting is missing for role ${this.role}`,
        module: MODULE_NAME, method: 'getPrivateKey',
      });
    }
    return this.settings[this.role].privateKey;
  }

  private getClientCertificate(action: ServerAction): string {
    if (!this.settings[this.role]) {
      throw new BackendError({
        action, message: `OICP Settings are missing for role ${this.role}`,
        module: MODULE_NAME, method: 'getClientCertificate',
      });
    }
    if (!this.settings[this.role].clientCertificate) {
      throw new BackendError({
        action, message: `OICP client certificate setting is missing for role ${this.role}`,
        module: MODULE_NAME, method: 'getClientCertificate',
      });
    }
    return this.settings[this.role].clientCertificate;
  }

  private getHttpsAgent(action: ServerAction): https.Agent {
    const publicCert = this.getClientCertificate(action);
    const privateKey = this.getPrivateKey(action);

    const httpsAgent = new https.Agent({
      rejectUnauthorized: false, // (NOTE: this will disable client verification)
      cert: publicCert,
      key: privateKey,
      passphrase: ''
    });
    return httpsAgent;
  }

  abstract triggerJobs(): Promise<{
    evses?: OICPJobResult,
    evseStatuses?: OICPJobResult;
  }>;

  abstract ping();
}
