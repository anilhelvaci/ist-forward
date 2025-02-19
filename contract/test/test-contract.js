// @ts-check

/* eslint-disable import/order -- https://github.com/endojs/endo/issues/1235 */
import { test } from './prepare-test-env-ava.js';
import path from 'path';

import bundleSource from '@endo/bundle-source';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';
import {
  makeNetworkProtocol,
  makeLoopbackProtocolHandler,
} from '@agoric/swingset-vat/src/vats/network/index.js';
import { makePromiseKit } from '@endo/promise-kit';
import { makeICS20TransferPacket } from '@agoric/pegasus/src/ics20.js';
import { setupPsm } from './setupPsm.js';
import buildManualTimer from '@agoric/zoe/tools/manualTimer.js';
import { AmountMath } from '@agoric/ertp';
import { eventLoopIteration } from '@agoric/internal/src/testing-utils.js';
import { unsafeMakeBundleCache } from '@agoric/swingset-vat/tools/bundleTool.js';

// @ts-ignore
const pathname = new URL(import.meta.url).pathname;
const dirname = path.dirname(pathname);

const contractPath = `${dirname}/../src/contract.js`;

test.before(async t => {
  const bundleCache = await unsafeMakeBundleCache('bundles/');
  t.context = { bundleCache };
});

test('zoe - forward to psm', async (t) => {
  try {
    const electorateTerms = { committeeName: 'EnBancPanel', committeeSize: 3 };
    const timer = buildManualTimer(t.log, 0n, { eventLoopIteration });

    const { knut, zoe, psm: psmM } =
      await setupPsm(t, electorateTerms, timer);
    
    // pack the contract
    const bundle = await bundleSource(contractPath);

    // install the contract
    const installation = E(zoe).install(bundle);

    // Create a network protocol to be used for testing
    const network = makeNetworkProtocol(makeLoopbackProtocolHandler());
    /** @type {Connection} */
    let remoteChannel;

    /**
     * Create the listener for the test port
     *
     * @type {ListenHandler}
     */
    const listener = Far('listener', {
      async onListen(_p, _listenHandler) {
        try {
          return
        } catch (err) {
          throw new Error(err)
        }
      },
      async onAccept(_p, _localAddrP, _remoteAddrP, _listenHandler) {
        try {
          return harden({
            async onOpen(c, localAddr, remoteAddr, _connectionHandler) {
              t.is(localAddr, '/ibc-port/random/nonce/4');
              t.is(remoteAddr, '/ibc-hop/connection-0/ibc-port/transfer/unordered/ics20-1/nonce/3');
              console.log("Connection opened: ", c);
            },
            async onReceive(_c, _packetBytes) {
              return '{"result":"AQ=="}';
            },
          });
        } catch (err) {
          throw new Error(err)
        }
      },
    });

    /**
     * Create the listener for the test port
     *
     * @type {ListenHandler}
     */
    const listener2 = Far('listener', {
      async onListen(_p, _listenHandler) {
        try {
          return
        } catch (err) {
          throw new Error(err)
        }
      },
      async onAccept(_p, _localAddrP, _remoteAddrP, _listenHandler) {
        try {
          return harden({
            async onOpen(c, localAddr, remoteAddr, _connectionHandler) {
              t.is(localAddr, '/ibc-hop/connection-0/ibc-port/transfer/unordered/ics20-1/nonce/2');
              t.is(remoteAddr, '/ibc-port/random/nonce/1');
              console.log("Connection opened: ", c);
              remoteChannel = c
            },
            async onReceive(_c, _packetBytes) {
              return '{"result":"AQ=="}';
            },
          });
        } catch (err) {
          throw new Error(err)
        }
      },
    });

    // Create and send packet to our ist forward port from new port
    const port = await E(network).bind('/ibc-port/random');
    await port.addListener(listener);

    // Create and send packet to our ist forward port from new port
    const port2 = await E(network).bind('/ibc-hop/connection-0/ibc-port/transfer/unordered/ics20-1');
    await port2.addListener(listener2);

    // create transfer port on connection-0
    /**
     * @type {PromiseRecord<DepositFacet>}
     */
    const { promise: localDepositFacet, resolve: resolveLocalDepositFacet } =
      makePromiseKit();
    const fakeBoard = Far('fakeBoard', {
      getValue(id) {
        if (id === 'agoric1234567') {
          return localDepositFacet;
        }
        throw Error(`unrecognized board id ${id}`);
      },
    });
    const fakeNamesByAddress = Far('fakeNamesByAddress', {
      lookup(...keys) {
        t.is(keys[0], 'agoric1234567', 'unrecognized fakeNamesByAddress');
        t.is(keys[1], 'depositFacet', 'lookup not for the depositFacet');
        t.is(keys.length, 2);
        return localDepositFacet;
      },
    });

    const minter = knut.mint
    const istIssuer = await E(zoe).getFeeIssuer();
    const istBrand = await E(istIssuer).getBrand();

    /** @type {Purse} */
    const localPursePIst = await E(E(zoe).getFeeIssuer()).makeEmptyPurse();
    resolveLocalDepositFacet(E(localPursePIst).getDepositFacet());

    const psm = await E(zoe).getPublicFacet(psmM.instance);

    const { publicFacet } = await E(zoe).startInstance(
      installation,
      {
        IST: istIssuer,
        Anchor: knut.issuer,
      },
      // @ts-ignore
      { board: fakeBoard, namesByAddress: fakeNamesByAddress, network, psm, remoteConnectionId: "connection-0", port },
      { minter },
    );

    const info = await E(publicFacet).channelInfo();
    console.log("info: ", info);

    /** @type {Data} */
    const packet = await makeICS20TransferPacket({
      "value": 10n,
      "remoteDenom": "KNUT",
      "depositAddress": 'agoric1234567'
    });
    // send a transfer packet
    // @ts-ignore
    const pingack = await remoteChannel.send(packet);
    console.log("Packet ack: ", pingack);
    t.is(pingack, '{"result":"AQ=="}', 'expected {"result":"AQ=="}');

    const userIstBalanceBefore = await E(localPursePIst).getCurrentAmount();
    console.log("userIstBalanceBefore: ", userIstBalanceBefore.value);
    t.deepEqual(userIstBalanceBefore.value, 1000000n);

    const invitation = await E(publicFacet).makeSendTransferInvitation();
    const giveIstAmount = AmountMath.make(istBrand, 1000000n);

    const proposal = harden({
      give: {
        IST: giveIstAmount,
      }
    });

    const payment = harden({
      IST: await E(localPursePIst).withdraw(giveIstAmount),
    });

    // @ts-ignore
    let localAddr = await E(remoteChannel).getRemoteAddress();

    const userSeat = await E(zoe).offer(
      invitation,
      proposal,
      payment,
      harden({
        remoteDenom: 'KNUT',
        receiver: 'osmo1234567',
        localAddr: localAddr
      })
    );
    console.log({userSeat})
    // @ts-ignore
    const { message, result } = await E(userSeat).getOfferResult();
    t.is(result, '{"result":"AQ=="}');
    t.is(message, 'Done');
    const userIstBalanceAfter = await E(localPursePIst).getCurrentAmount();
    console.log("userIstBalanceAfter: ", userIstBalanceAfter.value);

    t.deepEqual(userIstBalanceAfter.value, 0n);
  } catch (err) {
    throw new Error(err)
  }
});