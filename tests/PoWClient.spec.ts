import 'mocha';
import { expect } from 'chai';
import { RawData } from 'ws';
import { bindTestStubs, FakeWebSocket, unbindTestStubs } from './common';
import { PoWClient } from "../src/websock/PoWClient";
import { faucetConfig, loadFaucetConfig } from '../src/common/FaucetConfig';
import { ServiceManager } from '../src/common/ServiceManager';
import { PoWSession } from '../src/websock/PoWSession';
import { FaucetStoreDB } from '../src/services/FaucetStoreDB';
import { sleepPromise } from '../src/utils/SleepPromise';

class TestPoWClient extends PoWClient {
  private sentMessages: {
    action: string;
    data: any;
    rsp: any;
  }[] = [];

  public emitClientMessage(data: RawData) {
    return this.onClientMessage(data, false);
  }

  public override sendMessage(action: string, data?: any, rsp?: any) {
    this.sentMessages.push({
      action: action,
      data: data,
      rsp: rsp
    });
  }

  public getSentMessage(action: string): any {
    for(let i = 0; i < this.sentMessages.length; i++) {
      if(this.sentMessages[i].action === action)
        return this.sentMessages[i];
    }
  }

  public clearSentMessages() {
    this.sentMessages = [];
  }
}

describe("WebSocket Client Handling", () => {
  let globalStubs;

  beforeEach(() => {
    globalStubs = bindTestStubs();
    loadFaucetConfig(true);
    faucetConfig.faucetStats = null;
    faucetConfig.faucetDBFile = ":memory:";
    ServiceManager.InitService(FaucetStoreDB).initialize();
  });
  afterEach(() => {
    PoWSession.resetSessionData();
    ServiceManager.GetService(FaucetStoreDB).closeDatabase();
    ServiceManager.ClearAllServices();
    unbindTestStubs();
  });

  function encodeClientMessage(message: any): Buffer {
    let msgStr = JSON.stringify(message);
    return Buffer.from(msgStr);
  }

  describe("Request Handling: getConfig", () => {
    it("valid getConfig call", async () => {
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "getConfig",
        data: {
          version: "0.0.1337"
        }
      }));
      expect(client.getSentMessage("config")).to.not.equal(null, "no config response");
      expect(client.getSentMessage("config")?.rsp).to.equal("test", "response id mismatch");
      expect(client.getClientVersion()).to.equal("0.0.1337", "getClientVersion check failed");
    });
  });

  describe("Request Handling: startSession", () => {
    it("valid startSession call", async () => {
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "startSession",
        data: {
          addr: "0x0000000000000000000000000000000000001337",
          token: "test-captcha-token"
        }
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.equal("ok", "no result response");
      expect(resultResponse?.rsp).to.equal("test", "response id mismatch");
      expect(resultResponse?.data.targetAddr).to.equal("0x0000000000000000000000000000000000001337", "target address mismatch");
      expect(resultResponse?.data.startTime).to.be.gte(Math.floor(new Date().getTime()/1000) - 1, "invalid startTime");
    });
    it("rejected startSession call (faucet disabled)", async () => {
      faucetConfig.denyNewSessions = "Faucet disabled";
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "startSession",
        data: {
          addr: "0x0000000000000000000000000000000000001337",
          token: "test-captcha-token"
        }
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.not.equal("ok", "unexpected success response");
      let errorResponse = client.getSentMessage("error");
      expect(errorResponse?.rsp).to.equal("test", "response id mismatch");
      expect(errorResponse?.data.code).to.equal("FAUCET_DISABLED", "unexpected error code");
    });
    it("invalid startSession call (captcha verification)", async () => {
      faucetConfig.captchas.checkSessionStart = true;
      globalStubs["CaptchaVerifier.verifyToken"].resolves(false);
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "startSession",
        data: {
          addr: "0x0000000000000000000000000000000000001337",
          token: "test-captcha-token"
        }
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.not.equal("ok", "unexpected success response");
      let errorResponse = client.getSentMessage("error");
      expect(errorResponse?.rsp).to.equal("test", "response id mismatch");
      expect(errorResponse?.data.code).to.equal("INVALID_CAPTCHA", "unexpected error code");
    });
    it("valid startSession call (ens name)", async () => {
      globalStubs["EnsWeb3Manager.verifyToken"].resolves("0x0000000000000000000000000000000000001337");
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "startSession",
        data: {
          addr: "test.eth",
          token: "test-captcha-token"
        }
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.equal("ok", "no result response");
      expect(resultResponse?.rsp).to.equal("test", "response id mismatch");
      expect(resultResponse?.data.targetAddr).to.equal("0x0000000000000000000000000000000000001337", "target address mismatch");
    });
    it("invalid startSession call (invalid address)", async () => {
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "startSession",
        data: {
          addr: "not_a_address",
          token: "test-captcha-token"
        }
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.not.equal("ok", "unexpected success response");
      let errorResponse = client.getSentMessage("error");
      expect(errorResponse?.rsp).to.equal("test", "response id mismatch");
      expect(errorResponse?.data.code).to.equal("INVALID_ADDR", "unexpected error code");
    });
    it("invalid startSession call (wallet balance exceeds limit)", async () => {
      globalStubs["EthWeb3Manager.getWalletBalance"].resolves("1000");
      faucetConfig.claimAddrMaxBalance = 500;
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "startSession",
        data: {
          addr: "0x0000000000000000000000000000000000001337",
          token: "test-captcha-token"
        }
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.not.equal("ok", "unexpected success response");
      let errorResponse = client.getSentMessage("error");
      expect(errorResponse?.rsp).to.equal("test", "response id mismatch");
      expect(errorResponse?.data.code).to.equal("BALANCE_LIMIT", "unexpected error code");
    });
    it("invalid startSession call (wallet is contract)", async () => {
      globalStubs["EthWeb3Manager.checkIsContract"].resolves(true);
      faucetConfig.claimAddrDenyContract = true;
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "startSession",
        data: {
          addr: "0x0000000000000000000000000000000000001337",
          token: "test-captcha-token"
        }
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.not.equal("ok", "unexpected success response");
      let errorResponse = client.getSentMessage("error");
      expect(errorResponse?.rsp).to.equal("test", "response id mismatch");
      expect(errorResponse?.data.code).to.equal("CONTRACT_ADDR", "unexpected error code");
    });
    it("invalid startSession call (failed ipinfo call)", async () => {
      globalStubs["IPInfoResolver.getIpInfo"].resolves({
        status: "failed",
      });
      faucetConfig.ipInfoRequired = true;
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "startSession",
        data: {
          addr: "0x0000000000000000000000000000000000001337",
          token: "test-captcha-token"
        }
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.not.equal("ok", "unexpected success response");
      let errorResponse = client.getSentMessage("error");
      expect(errorResponse?.rsp).to.equal("test", "response id mismatch");
      expect(errorResponse?.data.code).to.equal("INVALID_IPINFO", "unexpected error code");
    });
  });

  describe("Request Handling: resumeSession", () => {
    it("valid resumeSession call", async () => {
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      let session = new PoWSession(client, "0x0000000000000000000000000000000000001337");
      session.setLastNonce(1337);
      client.setSession(null);
      session.setActiveClient(null);
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "resumeSession",
        data: {
          sessionId: session.getSessionId()
        }
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.equal("ok", "no result response");
      expect(resultResponse?.rsp).to.equal("test", "response id mismatch");
      expect(resultResponse?.data.lastNonce).to.equal(1337, "lastNonce mismatch");
    });
    it("invalid resumeSession call (unknown session id)", async () => {
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "resumeSession",
        data: {
          sessionId: "6e7509b8-f64b-40ce-8697-9be8720a3ba0"
        }
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.not.equal("ok", "unexpected success response");
      let errorResponse = client.getSentMessage("error");
      expect(errorResponse?.rsp).to.equal("test", "response id mismatch");
      expect(errorResponse?.data.code).to.equal("INVALID_SESSIONID", "unexpected error code");
    });
    it("invalid resumeSession call (closed session)", async () => {
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      let session = new PoWSession(client, "0x0000000000000000000000000000000000001337");
      session.setLastNonce(1337);
      session.addBalance(BigInt(faucetConfig.claimMinAmount));
      session.closeSession(true, true, "test");
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "resumeSession",
        data: {
          sessionId: session.getSessionId(),
        }
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.not.equal("ok", "unexpected success response");
      let errorResponse = client.getSentMessage("error");
      expect(errorResponse?.rsp).to.equal("test", "response id mismatch");
      expect(errorResponse?.data.code).to.equal("SESSION_CLOSED", "unexpected error code");
      expect(errorResponse?.data.data.balance).to.equal(faucetConfig.claimMinAmount.toString(), "invalid claim-token amount");
    });
  });

  describe("Request Handling: recoverSession", () => {
    it("valid recoverSession call", async () => {
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      let session = new PoWSession(client, "0x0000000000000000000000000000000000001337");
      session.setLastNonce(1337);
      session.addBalance(100n);
      let recoverToken = session.getSignedSession();
      client.setSession(null);
      session.setActiveClient(null);
      PoWSession.resetSessionData();
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "recoverSession",
        data: recoverToken
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.equal("ok", "no result response");
      expect(resultResponse?.rsp).to.equal("test", "response id mismatch");
    });
    it("invalid recoverSession call (invalid recovery data)", async () => {
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "recoverSession",
        data: "not_recovery_data"
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.not.equal("ok", "unexpected success response");
      let errorResponse = client.getSentMessage("error");
      expect(errorResponse?.rsp).to.equal("test", "response id mismatch");
      expect(errorResponse?.data.code).to.equal("INVALID_DATA", "unexpected error code");
    });
    it("invalid recoverSession call (closed session)", async () => {
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      let session = new PoWSession(client, "0x0000000000000000000000000000000000001337");
      session.setLastNonce(1337);
      session.addBalance(BigInt(faucetConfig.claimMinAmount));
      let recoverToken = session.getSignedSession();
      session.closeSession(true, true, "test");
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "recoverSession",
        data: recoverToken
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.not.equal("ok", "unexpected success response");
      let errorResponse = client.getSentMessage("error");
      expect(errorResponse?.rsp).to.equal("test", "response id mismatch");
      expect(errorResponse?.data.code).to.equal("INVALID_SESSION", "unexpected error code");
    });
    it("invalid recoverSession call (claim timeout)", async () => {
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      let sessionTime = (new Date().getTime() / 1000) - faucetConfig.claimSessionTimeout - 1;
      let session = new PoWSession(client, {
        id: "f081154a-3b93-4972-9ae7-b83f3307bb0f",
        startTime: sessionTime,
        targetAddr: "0x0000000000000000000000000000000000001337",
        preimage: "abcdefg",
        balance: "100",
        nonce: 50,
        ident: "xyz-zyx",
      });
      session.setLastNonce(1337);
      session.addBalance(BigInt(faucetConfig.claimMinAmount));
      let recoverToken = session.getSignedSession();
      session.closeSession(true, true, "test");
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "recoverSession",
        data: recoverToken
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.not.equal("ok", "unexpected success response");
      let errorResponse = client.getSentMessage("error");
      expect(errorResponse?.rsp).to.equal("test", "response id mismatch");
      expect(errorResponse?.data.code).to.equal("SESSION_TIMEOUT", "unexpected error code");
    });
    it("valid recoverSession call + immediate session close (session timeout)", async () => {
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      let sessionTime = (new Date().getTime() / 1000) - faucetConfig.powSessionTimeout - 1;
      let session = new PoWSession(client, {
        id: "f081154a-3b93-4972-9ae7-b83f3307bb0f",
        startTime: sessionTime,
        targetAddr: "0x0000000000000000000000000000000000001337",
        preimage: "abcdefg",
        balance: "100",
        nonce: 50,
        ident: "xyz-zyx",
      });
      session.setLastNonce(1337);
      session.addBalance(BigInt(faucetConfig.claimMinAmount));
      let recoverToken = session.getSignedSession();
      await sleepPromise(100);
      let killResponse = client.getSentMessage("sessionKill");
      client.clearSentMessages();
      expect(killResponse?.data.level).to.equal("timeout", "session has not been killed immediatly");
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "recoverSession",
        data: recoverToken
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.equal("ok", "no result response");
      expect(resultResponse?.rsp).to.equal("test", "response id mismatch");
      await sleepPromise(100);
      killResponse = client.getSentMessage("sessionKill");
      expect(killResponse?.data.level).to.equal("timeout", "recovered session has not been killed immediatly");
      expect(killResponse?.data.token).to.have.lengthOf.at.least(100, "recovered session got killed without claim token");
    });
  });

  describe("Request Handling: foundShare", () => {
    it("valid foundShare call", async () => {
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      let sessionTime = (new Date().getTime() / 1000) - 42;
      let session = new PoWSession(client, {
        id: "f081154a-3b93-4972-9ae7-b83f3307bb0f",
        startTime: sessionTime,
        targetAddr: "0x0000000000000000000000000000000000001337",
        preimage: "CIogLzT0cLA=",
        balance: "0",
        nonce: 0,
        ident: "xyz-zyx",
      });
      faucetConfig.powNonceCount = 1;
      faucetConfig.powScryptParams = {
        cpuAndMemory: 4096,
        blockSize: 8,
        parallelization: 1,
        keyLength: 16,
        difficulty: 9
      };
      faucetConfig.verifyLocalPercent = 0;
      faucetConfig.verifyLocalLowPeerPercent = 0;
      faucetConfig.verifyMinerPeerCount = 10;
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "foundShare",
        data: {
          nonces: [156],
          params: "4096|8|1|16|9",
          hashrate: 50
        }
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.equal("ok", "no result response");
      expect(resultResponse?.rsp).to.equal("test", "response id mismatch");
      await sleepPromise(20);
      let balanceResponse = client.getSentMessage("updateBalance");
      expect(balanceResponse?.action).to.equal("updateBalance", "no balance update response");
      expect(parseInt(balanceResponse?.data.balance)).to.be.at.least(1, "balance too low");
    });
    it("invalid foundShare call (pow params mismatch)", async () => {
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      let sessionTime = (new Date().getTime() / 1000) - 42;
      let session = new PoWSession(client, {
        id: "f081154a-3b93-4972-9ae7-b83f3307bb0f",
        startTime: sessionTime,
        targetAddr: "0x0000000000000000000000000000000000001337",
        preimage: "CIogLzT0cLA=",
        balance: "0",
        nonce: 0,
        ident: "xyz-zyx",
      });
      faucetConfig.powNonceCount = 1;
      faucetConfig.powScryptParams = {
        cpuAndMemory: 4096,
        blockSize: 8,
        parallelization: 1,
        keyLength: 16,
        difficulty: 9
      };
      faucetConfig.verifyLocalLowPeerPercent = 0;
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "foundShare",
        data: {
          nonces: [156],
          params: "2048|8|1|16|12",
          hashrate: 50
        }
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.not.equal("ok", "unexpected success response");
      let errorResponse = client.getSentMessage("error");
      expect(errorResponse?.rsp).to.equal("test", "response id mismatch");
      expect(errorResponse?.data.code).to.equal("INVALID_SHARE", "unexpected error code");
    });
    it("invalid foundShare call (nonce too low)", async () => {
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      let sessionTime = (new Date().getTime() / 1000) - 42;
      let session = new PoWSession(client, {
        id: "f081154a-3b93-4972-9ae7-b83f3307bb0f",
        startTime: sessionTime,
        targetAddr: "0x0000000000000000000000000000000000001337",
        preimage: "CIogLzT0cLA=",
        balance: "0",
        nonce: 200,
        ident: "xyz-zyx",
      });
      faucetConfig.powNonceCount = 1;
      faucetConfig.powScryptParams = {
        cpuAndMemory: 4096,
        blockSize: 8,
        parallelization: 1,
        keyLength: 16,
        difficulty: 9
      };
      faucetConfig.verifyLocalLowPeerPercent = 0;
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "foundShare",
        data: {
          nonces: [156],
          params: "4096|8|1|16|9",
          hashrate: 50
        }
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.not.equal("ok", "unexpected success response");
      let errorResponse = client.getSentMessage("error");
      expect(errorResponse?.rsp).to.equal("test", "response id mismatch");
      expect(errorResponse?.data.code).to.equal("INVALID_SHARE", "unexpected error code");
    });
    it("invalid foundShare call (nonce too high)", async () => {
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      let sessionTime = (new Date().getTime() / 1000) - 42;
      let session = new PoWSession(client, {
        id: "f081154a-3b93-4972-9ae7-b83f3307bb0f",
        startTime: sessionTime,
        targetAddr: "0x0000000000000000000000000000000000001337",
        preimage: "CIogLzT0cLA=",
        balance: "0",
        nonce: 200,
        ident: "xyz-zyx",
      });
      faucetConfig.powNonceCount = 1;
      faucetConfig.powScryptParams = {
        cpuAndMemory: 4096,
        blockSize: 8,
        parallelization: 1,
        keyLength: 16,
        difficulty: 9
      };
      faucetConfig.verifyLocalLowPeerPercent = 0;
      faucetConfig.powHashrateHardLimit = 10;
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "foundShare",
        data: {
          nonces: [3468],
          params: "4096|8|1|16|9",
          hashrate: 50
        }
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.not.equal("ok", "unexpected success response");
      let errorResponse = client.getSentMessage("error");
      expect(errorResponse?.rsp).to.equal("test", "response id mismatch");
      expect(errorResponse?.data.code).to.equal("HASHRATE_LIMIT", "unexpected error code");
    });
  });

  describe("Request Handling: verifyResult", () => {
    it("valid verifyResult call", async () => {
      let client1 = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      let client2 = new TestPoWClient(new FakeWebSocket(), "8.8.4.4");
      let sessionTime = (new Date().getTime() / 1000) - 42;
      let session1 = new PoWSession(client1, {
        id: "f081154a-3b93-4972-9ae7-b83f3307bb0f",
        startTime: sessionTime,
        targetAddr: "0x0000000000000000000000000000000000001337",
        preimage: "CIogLzT0cLA=",
        balance: "0",
        nonce: 0,
        ident: "xyz-zyx",
      });
      let session2 = new PoWSession(client2, "0x0000000000000000000000000000000000001338");
      session2.addBalance(BigInt(faucetConfig.powShareReward));
      faucetConfig.powNonceCount = 1;
      faucetConfig.powScryptParams = {
        cpuAndMemory: 4096,
        blockSize: 8,
        parallelization: 1,
        keyLength: 16,
        difficulty: 9
      };
      faucetConfig.verifyMinerIndividuals = 1;
      faucetConfig.verifyMinerPeerCount = 1;
      faucetConfig.verifyLocalPercent = 0;
      faucetConfig.verifyMinerPercent = 100;
      await client1.emitClientMessage(encodeClientMessage({
        id: "test1",
        action: "foundShare",
        data: {
          nonces: [156],
          params: "4096|8|1|16|9",
          hashrate: 50
        }
      }));
      await sleepPromise(50);
      let verifyRequest = client2.getSentMessage("verify");
      expect(verifyRequest?.action).to.equal("verify", "no verify request for verifier session");
      expect(verifyRequest.data.preimage).to.equal("CIogLzT0cLA=", "invalid preimage in verify request");
      expect(verifyRequest.data.nonces[0]).to.equal(156, "invalid nonce in verify request");
      await client2.emitClientMessage(encodeClientMessage({
        id: "test2",
        action: "verifyResult",
        data: {
          shareId: verifyRequest.data.shareId,
          isValid: true
        }
      }));
      let balanceResponse = client2.getSentMessage("updateBalance");
      expect(balanceResponse?.action).to.equal("updateBalance", "no balance update response");
      expect(parseInt(balanceResponse?.data.balance)).to.be.at.least(1, "balance too low");
      let resultResponse = client1.getSentMessage("ok");
      expect(resultResponse?.action).to.equal("ok", "no miner result response");
      expect(resultResponse?.rsp).to.equal("test1", "miner response id mismatch");
    });
  });

  describe("Request Handling: closeSession", () => {
    it("valid closeSession call", async () => {
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      let session = new PoWSession(client, "0x0000000000000000000000000000000000001337");
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "closeSession",
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.equal("ok", "no result response");
      expect(resultResponse?.rsp).to.equal("test", "response id mismatch");
    });
    it("valid closeSession call (with claimable balance)", async () => {
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      let session = new PoWSession(client, "0x0000000000000000000000000000000000001337");
      session.addBalance(BigInt(faucetConfig.claimMinAmount));
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "closeSession",
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.equal("ok", "no result response");
      expect(resultResponse?.rsp).to.equal("test", "response id mismatch");
      expect(resultResponse?.data.claimable).to.equal(true, "not claimable");
    });
    it("invalid closeSession call (no session)", async () => {
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "closeSession",
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.not.equal("ok", "unexpected success response");
      let errorResponse = client.getSentMessage("error");
      expect(errorResponse?.rsp).to.equal("test", "response id mismatch");
      expect(errorResponse?.data.code).to.equal("SESSION_NOT_FOUND", "unexpected error code");
    });
  });
  
  describe("Request Handling: claimRewards", () => {
    it("valid claimRewards call", async () => {
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      let session = new PoWSession(client, "0x0000000000000000000000000000000000001337");
      session.addBalance(BigInt(faucetConfig.claimMinAmount));
      session.closeSession(true, true, "test");
      let claimToken = session.getSignedSession();
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "claimRewards",
        data: {
          token: claimToken,
          captcha: "captcha_token"
        }
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.equal("ok", "no result response");
      expect(resultResponse?.rsp).to.equal("test", "response id mismatch");
    });
    it("invalid claimRewards call (captcha verification)", async () => {
      faucetConfig.captchas.checkBalanceClaim = true;
      globalStubs["CaptchaVerifier.verifyToken"].resolves(false);
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      let session = new PoWSession(client, "0x0000000000000000000000000000000000001337");
      session.addBalance(BigInt(faucetConfig.claimMinAmount));
      session.closeSession(true, true, "test");
      let claimToken = session.getSignedSession();
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "claimRewards",
        data: {
          token: claimToken,
          captcha: "captcha_token"
        }
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.not.equal("ok", "unexpected success response");
      let errorResponse = client.getSentMessage("error");
      expect(errorResponse?.rsp).to.equal("test", "response id mismatch");
      expect(errorResponse?.data.code).to.equal("INVALID_CAPTCHA", "unexpected error code");
    });
    it("invalid claimRewards call (invalid token)", async () => {
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "claimRewards",
        data: {
          token: "invalid_claim_token",
          captcha: "captcha_token"
        }
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.not.equal("ok", "unexpected success response");
      let errorResponse = client.getSentMessage("error");
      expect(errorResponse?.rsp).to.equal("test", "response id mismatch");
      expect(errorResponse?.data.code).to.equal("INVALID_CLAIM", "unexpected error code");
    });
    it("invalid claimRewards call (expired claim)", async () => {
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      let sessionTime = (new Date().getTime() / 1000) - faucetConfig.claimSessionTimeout - 2;
      let session = new PoWSession(client, {
        id: "f081154a-3b93-4972-9ae7-b83f3307bb0f",
        startTime: sessionTime,
        targetAddr: "0x0000000000000000000000000000000000001337",
        preimage: "CIogLzT0cLA=",
        balance: faucetConfig.claimMinAmount.toString(),
        nonce: 0,
        ident: "xyz-zyx",
      });
      session.closeSession(true, true, "test");
      await sleepPromise(10);
      let claimToken = session.getSignedSession();
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "claimRewards",
        data: {
          token: claimToken,
          captcha: "captcha_token"
        }
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.not.equal("ok", "unexpected success response");
      let errorResponse = client.getSentMessage("error");
      expect(errorResponse?.rsp).to.equal("test", "response id mismatch");
      expect(errorResponse?.data.code).to.equal("INVALID_CLAIM", "unexpected error code");
    });
  });

  describe("Request Handling: watchClaimTx", () => {
    it("valid watchClaimTx call", async () => {
      let client1 = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      let session = new PoWSession(client1, "0x0000000000000000000000000000000000001337");
      session.addBalance(BigInt(faucetConfig.claimMinAmount));
      session.closeSession(true, true, "test");
      let claimToken = session.getSignedSession();
      await client1.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "claimRewards",
        data: {
          token: claimToken,
          captcha: "captcha_token"
        }
      }));
      let claimResultResponse = client1.getSentMessage("ok");
      expect(claimResultResponse?.action).to.equal("ok", "no result response");
      expect(claimResultResponse?.rsp).to.equal("test", "response id mismatch");
      let client2 = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      await client2.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "watchClaimTx",
        data: {
          sessionId: session.getSessionId(),
        }
      }));
      let resultResponse = client2.getSentMessage("ok");
      expect(resultResponse?.action).to.equal("ok", "no result response");
      expect(resultResponse?.rsp).to.equal("test", "response id mismatch");
    });
    it("invalid watchClaimTx call (unknown session id)", async () => {
      let client = new TestPoWClient(new FakeWebSocket(), "8.8.8.8");
      await client.emitClientMessage(encodeClientMessage({
        id: "test",
        action: "watchClaimTx",
        data: {
          sessionId: "38f04fda-5a52-4694-84e5-12edbed9539e"
        }
      }));
      let resultResponse = client.getSentMessage("ok");
      expect(resultResponse?.action).to.not.equal("ok", "unexpected success response");
      let errorResponse = client.getSentMessage("error");
      expect(errorResponse?.rsp).to.equal("test", "response id mismatch");
      expect(errorResponse?.data.code).to.equal("CLAIM_NOT_FOUND", "unexpected error code");
    });
  });
  
});