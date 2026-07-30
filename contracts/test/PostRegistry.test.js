import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { deployPinnedUserRegistry, PINNED_USER_REGISTRY } from "./helpers/pinnedUserRegistry.js";

const DAY = 24 * 60 * 60;

const Policy = { Open: 0, Moderated: 1, OwnerOnly: 2 };

// A real CIDv1 base32 shape, so the length checks are exercised against something plausible.
const CID_A = "bafybeid57rs2jcvyny3vfbryye6unkzg4winpidkugt27h4yzqchipku5y";
const CID_B = "bafybeigdof6hgoqmf7ycfucfxlb3zr6xeozrxpgjjjmma7d64bsht4xwda";
const CID_C = "bafybeie3sxni3t47ztcitjnggfiaiqpoquzsj6u2um4pucgrm2lwz3ffuy";

const ROOM = ethers.keccak256(ethers.toUtf8Bytes("room:general"));
const FEED = ethers.keccak256(ethers.toUtf8Bytes("feed"));
const NO_GROUP = ethers.ZeroHash;

function idFor(creator, salt) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "bytes32"], [creator, salt])
  );
}

async function now() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

async function increaseTime(seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("PostRegistry", function () {
  let userRegistry;
  let postRegistry;
  let alice;
  let bob;
  let carol;
  let delegate;
  let stranger;

  beforeEach(async function () {
    [alice, bob, carol, delegate, stranger] = await ethers.getSigners();

    userRegistry = await deployPinnedUserRegistry();

    const PostRegistry = await ethers.getContractFactory("PostRegistry");
    postRegistry = await PostRegistry.deploy();
  });

  describe("Deployment", function () {
    it("Should pin the UserRegistry rather than accept one", async function () {
      // The dependency is a compile-time constant because `cdm deploy` cannot pass constructor
      // arguments. Asserting the constructor takes NO arguments is the test that would catch
      // someone helpfully "fixing" it back into a parameter and breaking every devnet deploy.
      const PostRegistry = await ethers.getContractFactory("PostRegistry");
      expect(PostRegistry.interface.deploy.inputs).to.have.lengthOf(0);
      expect(await postRegistry.userRegistry()).to.equal(PINNED_USER_REGISTRY);
    });

    it("Should refuse to deploy when nothing is at the pinned address", async function () {
      // A pinned address is network-specific, so this guard is the difference between a deploy that
      // fails immediately and a contract whose delegated writes all revert opaquely much later.
      await hre.network.provider.send("hardhat_setCode", [PINNED_USER_REGISTRY, "0x"]);
      const PostRegistry = await ethers.getContractFactory("PostRegistry");
      await expect(PostRegistry.deploy())
        .to.be.revertedWithCustomError(PostRegistry, "UserRegistryNotDeployed");
    });

    it("Should expose no admin, pause or upgrade surface", async function () {
      for (const name of [
        "owner",
        "pause",
        "unpause",
        "transferOwnership",
        "upgradeTo",
        "clearHeadFor",
        "clearHeadOf",
      ]) {
        expect(postRegistry[name], name).to.equal(undefined);
      }
    });
  });

  describe("Setting a head", function () {
    it("Should record cid, prev, store block, timestamp and writer", async function () {
      await postRegistry.setHead(ROOM, NO_GROUP, CID_A, "", 1234);

      const head = await postRegistry.headOf(ROOM, alice.address);
      expect(head.cid).to.equal(CID_A);
      expect(head.prev).to.equal("");
      expect(head.storeBlock).to.equal(1234);
      expect(head.by).to.equal(alice.address);
      expect(head.movedAt).to.equal(await now());
      expect(head.allowed).to.be.true;
    });

    it("Should emit HeadSet with the store block, grouped under the registry by default", async function () {
      const tx = await postRegistry.setHead(ROOM, NO_GROUP, CID_A, CID_B, 99);
      await expect(tx)
        .to.emit(postRegistry, "HeadSet")
        .withArgs(ROOM, alice.address, ROOM, CID_A, CID_B, 99, await now());
    });

    it("Should route the event to an explicit group", async function () {
      const board = ethers.keccak256(ethers.toUtf8Bytes("board:solidity"));
      const thread = ethers.keccak256(ethers.toUtf8Bytes("thread:abc"));
      const tx = await postRegistry.setHead(thread, board, CID_A, "", 0);
      await expect(tx)
        .to.emit(postRegistry, "HeadSet")
        .withArgs(thread, alice.address, board, CID_A, "", 0, await now());
    });

    it("Should overwrite in place — one head per (registry, writer)", async function () {
      await postRegistry.setHead(ROOM, NO_GROUP, CID_A, "", 1);
      await postRegistry.setHead(ROOM, NO_GROUP, CID_B, CID_A, 2);
      await postRegistry.setHead(ROOM, NO_GROUP, CID_C, CID_B, 3);

      // Three posts, still exactly one row: this is the property that makes storage bounded.
      expect(await postRegistry.writerCount(ROOM)).to.equal(1);
      const head = await postRegistry.headOf(ROOM, alice.address);
      expect(head.cid).to.equal(CID_C);
      expect(head.prev).to.equal(CID_B);
    });

    it("Should accept re-announcing the same cid as a deadline refresh", async function () {
      // This is how a writer records the new store block after their content is renewed — the
      // expiry deadline moves, the CID does not.
      await postRegistry.setHead(ROOM, NO_GROUP, CID_A, "", 100);
      const first = await postRegistry.headOf(ROOM, alice.address);

      await increaseTime(60);
      await postRegistry.setHead(ROOM, NO_GROUP, CID_A, "", 500);

      const second = await postRegistry.headOf(ROOM, alice.address);
      expect(second.cid).to.equal(CID_A);
      expect(second.storeBlock).to.equal(500);
      expect(second.movedAt).to.be.greaterThan(first.movedAt);
    });

    it("Should keep writers' rows separate", async function () {
      await postRegistry.setHead(ROOM, NO_GROUP, CID_A, "", 0);
      await postRegistry.connect(bob).setHead(ROOM, NO_GROUP, CID_B, "", 0);

      expect((await postRegistry.headOf(ROOM, alice.address)).cid).to.equal(CID_A);
      expect((await postRegistry.headOf(ROOM, bob.address)).cid).to.equal(CID_B);
      expect(await postRegistry.writerCount(ROOM)).to.equal(2);
    });

    it("Should keep registries separate for one writer", async function () {
      await postRegistry.setHead(ROOM, NO_GROUP, CID_A, "", 0);
      await postRegistry.setHead(FEED, NO_GROUP, CID_B, "", 0);

      expect((await postRegistry.headOf(ROOM, alice.address)).cid).to.equal(CID_A);
      expect((await postRegistry.headOf(FEED, alice.address)).cid).to.equal(CID_B);
    });

    it("Should return an empty ref for a writer with no head", async function () {
      const head = await postRegistry.headOf(ROOM, stranger.address);
      expect(head.movedAt).to.equal(0);
      expect(head.cid).to.equal("");
    });

    it("Should reject an empty cid", async function () {
      await expect(postRegistry.setHead(ROOM, NO_GROUP, "", "", 0))
        .to.be.revertedWithCustomError(postRegistry, "CidEmpty");
    });

    it("Should reject an over-long cid or prev", async function () {
      const long = "b".repeat(129);
      await expect(postRegistry.setHead(ROOM, NO_GROUP, long, "", 0))
        .to.be.revertedWithCustomError(postRegistry, "CidTooLong")
        .withArgs(129, 128);
      await expect(postRegistry.setHead(ROOM, NO_GROUP, CID_A, long, 0))
        .to.be.revertedWithCustomError(postRegistry, "CidTooLong")
        .withArgs(129, 128);
    });

    it("Should accept a cid of exactly MAX_CID_BYTES", async function () {
      await postRegistry.setHead(ROOM, NO_GROUP, "b".repeat(128), "", 0);
      expect((await postRegistry.headOf(ROOM, alice.address)).cid.length).to.equal(128);
    });

    it("Should accept 0 as an unknown store block", async function () {
      await postRegistry.setHead(ROOM, NO_GROUP, CID_A, "", 0);
      expect((await postRegistry.headOf(ROOM, alice.address)).storeBlock).to.equal(0);
    });
  });

  describe("Clearing a head", function () {
    beforeEach(async function () {
      await postRegistry.setHead(ROOM, NO_GROUP, CID_A, "", 1);
      await postRegistry.connect(bob).setHead(ROOM, NO_GROUP, CID_B, "", 2);
      await postRegistry.connect(carol).setHead(ROOM, NO_GROUP, CID_C, "", 3);
    });

    it("Should free the row and emit", async function () {
      await expect(postRegistry.clearHead(ROOM, NO_GROUP))
        .to.emit(postRegistry, "HeadCleared")
        .withArgs(ROOM, alice.address, ROOM);

      expect((await postRegistry.headOf(ROOM, alice.address)).movedAt).to.equal(0);
      expect(await postRegistry.writerCount(ROOM)).to.equal(2);
    });

    it("Should keep the writer index consistent after a swap-and-pop", async function () {
      // Alice is at slot 0; clearing her moves Carol into it. Carol's stored index must follow, or
      // her own later clear would corrupt somebody else's slot.
      await postRegistry.clearHead(ROOM, NO_GROUP);

      const [writers] = await postRegistry.writersOf(ROOM, 0, 10);
      expect(writers).to.deep.equal([carol.address, bob.address]);

      await postRegistry.connect(carol).clearHead(ROOM, NO_GROUP);
      const [after] = await postRegistry.writersOf(ROOM, 0, 10);
      expect(after).to.deep.equal([bob.address]);
      expect((await postRegistry.headOf(ROOM, bob.address)).cid).to.equal(CID_B);
    });

    it("Should reject clearing a head that does not exist", async function () {
      await expect(postRegistry.connect(stranger).clearHead(ROOM, NO_GROUP))
        .to.be.revertedWithCustomError(postRegistry, "NoHead")
        .withArgs(ROOM, stranger.address);
    });

    it("Should let a writer re-create their row after clearing", async function () {
      await postRegistry.clearHead(ROOM, NO_GROUP);
      await postRegistry.setHead(ROOM, NO_GROUP, CID_A, "", 4);
      expect(await postRegistry.writerCount(ROOM)).to.equal(3);
      expect((await postRegistry.headOf(ROOM, alice.address)).cid).to.equal(CID_A);
    });

    it("Should offer no way for anyone else to clear a row", async function () {
      // The deposit invariant: freeing storage pays the refund to whoever freed it, so a delegated
      // or moderated clear would be deposit theft. There is no such entry point at all.
      await userRegistry.authorizeDelegate(delegate.address, (await now()) + DAY);
      expect(postRegistry.clearHeadFor).to.equal(undefined);

      // and the only clear there is touches the caller's own row, never the named writer's, so a
      // live delegate calling it hits its own empty row rather than Alice's
      await expect(postRegistry.connect(delegate).clearHead(ROOM, NO_GROUP))
        .to.be.revertedWithCustomError(postRegistry, "NoHead")
        .withArgs(ROOM, delegate.address);
      expect((await postRegistry.headOf(ROOM, alice.address)).cid).to.equal(CID_A);
    });
  });

  describe("Delegated writes", function () {
    it("Should credit the head to the principal, not the signer", async function () {
      await userRegistry.authorizeDelegate(delegate.address, (await now()) + DAY);

      const tx = await postRegistry
        .connect(delegate)
        .setHeadFor(alice.address, ROOM, NO_GROUP, CID_A, "", 42);
      await expect(tx)
        .to.emit(postRegistry, "HeadSet")
        .withArgs(ROOM, alice.address, ROOM, CID_A, "", 42, await now());

      expect((await postRegistry.headOf(ROOM, alice.address)).cid).to.equal(CID_A);
      expect((await postRegistry.headOf(ROOM, delegate.address)).movedAt).to.equal(0);
    });

    it("Should let a principal use setHeadFor on themselves with no delegation", async function () {
      // One client code path whether or not a delegation exists.
      await postRegistry.setHeadFor(alice.address, ROOM, NO_GROUP, CID_A, "", 0);
      expect((await postRegistry.headOf(ROOM, alice.address)).cid).to.equal(CID_A);
    });

    it("Should reject a stranger writing someone else's row", async function () {
      await expect(
        postRegistry
          .connect(stranger)
          .setHeadFor(alice.address, ROOM, NO_GROUP, CID_A, "", 0)
      )
        .to.be.revertedWithCustomError(postRegistry, "NotDelegate")
        .withArgs(alice.address, stranger.address);
    });

    it("Should stop accepting a delegate once its authorization expires", async function () {
      const expiry = (await now()) + 100;
      await userRegistry.authorizeDelegate(delegate.address, expiry);
      await postRegistry
        .connect(delegate)
        .setHeadFor(alice.address, ROOM, NO_GROUP, CID_A, "", 0);

      await increaseTime(200);

      await expect(
        postRegistry
          .connect(delegate)
          .setHeadFor(alice.address, ROOM, NO_GROUP, CID_B, CID_A, 0)
      ).to.be.revertedWithCustomError(postRegistry, "NotDelegate");

      // the head the delegate already set stays valid and stays Alice's
      expect((await postRegistry.headOf(ROOM, alice.address)).cid).to.equal(CID_A);
    });

    it("Should stop accepting a delegate once revoked", async function () {
      await userRegistry.authorizeDelegate(delegate.address, (await now()) + DAY);
      await userRegistry.revokeDelegate(delegate.address);

      await expect(
        postRegistry
          .connect(delegate)
          .setHeadFor(alice.address, ROOM, NO_GROUP, CID_A, "", 0)
      ).to.be.revertedWithCustomError(postRegistry, "NotDelegate");
    });

    it("Should confine a delegate to the one principal that authorized it", async function () {
      await userRegistry.authorizeDelegate(delegate.address, (await now()) + DAY);
      await expect(
        postRegistry
          .connect(delegate)
          .setHeadFor(bob.address, ROOM, NO_GROUP, CID_A, "", 0)
      ).to.be.revertedWithCustomError(postRegistry, "NotDelegate");
    });

    it("Should serve two principals from one shared delegate address", async function () {
      // Delegate keys are derived and can collide across profiles; UserRegistry allows it, and the
      // index must too — while still keeping the two rows apart.
      const expiry = (await now()) + DAY;
      await userRegistry.authorizeDelegate(delegate.address, expiry);
      await userRegistry.connect(bob).authorizeDelegate(delegate.address, expiry);

      await postRegistry
        .connect(delegate)
        .setHeadFor(alice.address, ROOM, NO_GROUP, CID_A, "", 0);
      await postRegistry
        .connect(delegate)
        .setHeadFor(bob.address, ROOM, NO_GROUP, CID_B, "", 0);

      expect((await postRegistry.headOf(ROOM, alice.address)).cid).to.equal(CID_A);
      expect((await postRegistry.headOf(ROOM, bob.address)).cid).to.equal(CID_B);
    });

    it("Should not consult UserRegistry on the direct path", async function () {
      // A PostRegistry whose delegation authority is broken must still accept ordinary posts, so
      // that a broken authority degrades convenience and cannot break writing.
      //
      // The registry is pinned, so this breaks the authority in place rather than pointing a new
      // instance elsewhere: swap the code at the pinned address for something with no `canActAs`.
      // Done after deployment, so the constructor's code-presence guard still saw a real registry.
      const wrongCode = await ethers.provider.getCode(await postRegistry.getAddress());
      await hre.network.provider.send("hardhat_setCode", [PINNED_USER_REGISTRY, wrongCode]);

      await postRegistry.setHead(ROOM, NO_GROUP, CID_B, "", 0);
      expect((await postRegistry.headOf(ROOM, alice.address)).cid).to.equal(CID_B);

      await expect(
        postRegistry.connect(stranger).setHeadFor(alice.address, ROOM, NO_GROUP, CID_A, "", 0)
      ).to.be.reverted;
    });
  });

  describe("Registry ids", function () {
    it("Should derive a claimable id from the creator and salt", async function () {
      const salt = ethers.keccak256(ethers.toUtf8Bytes("solidity"));
      expect(await postRegistry.registryIdFor(alice.address, salt)).to.equal(
        idFor(alice.address, salt)
      );
    });

    it("Should give different creators different ids for the same salt", async function () {
      // This is the anti-squatting property: nobody can claim an id derived from someone else's
      // address, because claimRegistry only ever hashes its own caller.
      const salt = ethers.keccak256(ethers.toUtf8Bytes("solidity"));
      expect(await postRegistry.registryIdFor(alice.address, salt)).to.not.equal(
        await postRegistry.registryIdFor(bob.address, salt)
      );
    });

    it("Should hash an open registry id from its name", async function () {
      expect(await postRegistry.openRegistryId("room:general")).to.equal(ROOM);
    });
  });

  describe("Policy: unclaimed registries are open", function () {
    it("Should let anyone write and cost no config storage", async function () {
      const [admin, policy] = await postRegistry.registryConfig(ROOM);
      expect(admin).to.equal(ethers.ZeroAddress);
      expect(policy).to.equal(Policy.Open);

      expect(await postRegistry.canWrite(ROOM, stranger.address)).to.be.true;
      await postRegistry.connect(stranger).setHead(ROOM, NO_GROUP, CID_A, "", 0);
      expect((await postRegistry.headOf(ROOM, stranger.address)).allowed).to.be.true;
    });
  });

  describe("Policy: claiming", function () {
    const salt = ethers.keccak256(ethers.toUtf8Bytes("solidity"));
    let board;

    beforeEach(async function () {
      board = idFor(alice.address, salt);
    });

    it("Should claim the derived id and record the policy", async function () {
      await expect(postRegistry.claimRegistry(salt, Policy.Moderated))
        .to.emit(postRegistry, "RegistryClaimed")
        .withArgs(board, alice.address, Policy.Moderated);

      const [admin, policy] = await postRegistry.registryConfig(board);
      expect(admin).to.equal(alice.address);
      expect(policy).to.equal(Policy.Moderated);
    });

    it("Should reject a second claim of the same id", async function () {
      await postRegistry.claimRegistry(salt, Policy.Moderated);
      await expect(postRegistry.claimRegistry(salt, Policy.Open))
        .to.be.revertedWithCustomError(postRegistry, "AlreadyClaimed")
        .withArgs(board, alice.address);
    });

    it("Should not let another account claim someone's derived id", async function () {
      // Bob claiming the same salt produces HIS id, never Alice's — squatting is not possible,
      // rather than merely expensive.
      await postRegistry.connect(bob).claimRegistry(salt, Policy.OwnerOnly);
      const [aliceAdmin] = await postRegistry.registryConfig(board);
      expect(aliceAdmin).to.equal(ethers.ZeroAddress);

      const [bobAdmin] = await postRegistry.registryConfig(idFor(bob.address, salt));
      expect(bobAdmin).to.equal(bob.address);
    });

    it("Should let the admin change the policy, transfer and release", async function () {
      await postRegistry.claimRegistry(salt, Policy.Open);

      await expect(postRegistry.setRegistryPolicy(board, Policy.Moderated))
        .to.emit(postRegistry, "RegistryPolicyChanged")
        .withArgs(board, Policy.Moderated);

      await expect(postRegistry.transferRegistryAdmin(board, bob.address))
        .to.emit(postRegistry, "RegistryAdminTransferred")
        .withArgs(board, alice.address, bob.address);

      // ...and Alice is now a stranger to her own former board
      await expect(postRegistry.setRegistryPolicy(board, Policy.Open))
        .to.be.revertedWithCustomError(postRegistry, "NotRegistryAdmin")
        .withArgs(board, alice.address);

      await expect(postRegistry.connect(bob).releaseRegistry(board))
        .to.emit(postRegistry, "RegistryReleased")
        .withArgs(board, bob.address);

      // released ⇒ back to open, and the config slot is freed
      const [admin, policy] = await postRegistry.registryConfig(board);
      expect(admin).to.equal(ethers.ZeroAddress);
      expect(policy).to.equal(Policy.Open);
      expect(await postRegistry.canWrite(board, stranger.address)).to.be.true;
    });

    it("Should reject policy changes from non-admins", async function () {
      await postRegistry.claimRegistry(salt, Policy.Moderated);
      const asBob = postRegistry.connect(bob);
      for (const call of [
        () => asBob.setRegistryPolicy(board, Policy.Open),
        () => asBob.transferRegistryAdmin(board, bob.address),
        () => asBob.releaseRegistry(board),
        () => asBob.setWriterAllowed(board, bob.address, true),
      ]) {
        await expect(call()).to.be.revertedWithCustomError(postRegistry, "NotRegistryAdmin");
      }
    });

    it("Should reject zero addresses", async function () {
      await postRegistry.claimRegistry(salt, Policy.Moderated);
      await expect(postRegistry.transferRegistryAdmin(board, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(postRegistry, "ZeroAddress");
      await expect(postRegistry.setWriterAllowed(board, ethers.ZeroAddress, true))
        .to.be.revertedWithCustomError(postRegistry, "ZeroAddress");
    });
  });

  describe("Policy: Moderated", function () {
    const salt = ethers.keccak256(ethers.toUtf8Bytes("board"));
    let board;

    beforeEach(async function () {
      board = idFor(alice.address, salt);
      await postRegistry.claimRegistry(salt, Policy.Moderated);
    });

    it("Should let the admin write without being allow-listed", async function () {
      expect(await postRegistry.canWrite(board, alice.address)).to.be.true;
      await postRegistry.setHead(board, NO_GROUP, CID_A, "", 0);
    });

    it("Should reject a writer who is not allow-listed", async function () {
      expect(await postRegistry.canWrite(board, bob.address)).to.be.false;
      await expect(postRegistry.connect(bob).setHead(board, NO_GROUP, CID_B, "", 0))
        .to.be.revertedWithCustomError(postRegistry, "NotAllowedToWrite")
        .withArgs(board, bob.address);
    });

    it("Should admit and then eject a writer", async function () {
      await expect(postRegistry.setWriterAllowed(board, bob.address, true))
        .to.emit(postRegistry, "WriterAllowed")
        .withArgs(board, bob.address, true);

      await postRegistry.connect(bob).setHead(board, NO_GROUP, CID_B, "", 0);
      expect((await postRegistry.headOf(board, bob.address)).allowed).to.be.true;

      await postRegistry.setWriterAllowed(board, bob.address, false);
      expect(await postRegistry.canWrite(board, bob.address)).to.be.false;
      await expect(postRegistry.connect(bob).setHead(board, NO_GROUP, CID_C, CID_B, 0))
        .to.be.revertedWithCustomError(postRegistry, "NotAllowedToWrite");
    });

    it("Should keep an ejected writer's existing row and flag it as not allowed", async function () {
      // Moderation is a write gate, not a delete button: the row stays where its depositor put it,
      // and clients hide it on `allowed === false`.
      await postRegistry.setWriterAllowed(board, bob.address, true);
      await postRegistry.connect(bob).setHead(board, NO_GROUP, CID_B, "", 5);
      await postRegistry.setWriterAllowed(board, bob.address, false);

      const head = await postRegistry.headOf(board, bob.address);
      expect(head.cid).to.equal(CID_B);
      expect(head.allowed).to.be.false;
      expect(await postRegistry.writerCount(board)).to.equal(1);
    });

    it("Should check the allow-list against the principal, not the delegate", async function () {
      await postRegistry.setWriterAllowed(board, bob.address, true);
      await userRegistry.connect(bob).authorizeDelegate(delegate.address, (await now()) + DAY);

      await postRegistry
        .connect(delegate)
        .setHeadFor(bob.address, board, NO_GROUP, CID_B, "", 0);
      expect((await postRegistry.headOf(board, bob.address)).cid).to.equal(CID_B);

      // Carol's delegate is the same key, but Carol is not allow-listed
      await userRegistry.connect(carol).authorizeDelegate(delegate.address, (await now()) + DAY);
      await expect(
        postRegistry
          .connect(delegate)
          .setHeadFor(carol.address, board, NO_GROUP, CID_C, "", 0)
      )
        .to.be.revertedWithCustomError(postRegistry, "NotAllowedToWrite")
        .withArgs(board, carol.address);
    });
  });

  describe("Policy: OwnerOnly", function () {
    const salt = ethers.keccak256(ethers.toUtf8Bytes("announcements"));
    let feed;

    beforeEach(async function () {
      feed = idFor(alice.address, salt);
      await postRegistry.claimRegistry(salt, Policy.OwnerOnly);
    });

    it("Should let only the admin write", async function () {
      await postRegistry.setHead(feed, NO_GROUP, CID_A, "", 0);
      expect((await postRegistry.headOf(feed, alice.address)).cid).to.equal(CID_A);

      await expect(postRegistry.connect(bob).setHead(feed, NO_GROUP, CID_B, "", 0))
        .to.be.revertedWithCustomError(postRegistry, "NotAllowedToWrite")
        .withArgs(feed, bob.address);
    });

    it("Should ignore the allow-list", async function () {
      // OwnerOnly means owner only; an allow-list entry must not quietly widen it.
      await postRegistry.setWriterAllowed(feed, bob.address, true);
      expect(await postRegistry.canWrite(feed, bob.address)).to.be.false;
    });

    it("Should follow the admin on transfer", async function () {
      await postRegistry.transferRegistryAdmin(feed, bob.address);
      expect(await postRegistry.canWrite(feed, bob.address)).to.be.true;
      expect(await postRegistry.canWrite(feed, alice.address)).to.be.false;
    });

    it("Should still leave a plain per-writer feed unclaimed and safe", async function () {
      // The reason a profile feed usually needs no policy at all: reads name a (registry, writer)
      // pair, so a squatter's row in the shared FEED registry is one nobody asks for.
      await postRegistry.setHead(FEED, NO_GROUP, CID_A, "", 0);
      await postRegistry.connect(stranger).setHead(FEED, NO_GROUP, CID_B, "", 0);

      expect((await postRegistry.headOf(FEED, alice.address)).cid).to.equal(CID_A);
    });
  });

  describe("Read paths", function () {
    beforeEach(async function () {
      // three writers, distinct timestamps, first-write order alice → bob → carol
      await postRegistry.setHead(ROOM, NO_GROUP, CID_A, "", 1);
      await increaseTime(60);
      await postRegistry.connect(bob).setHead(ROOM, NO_GROUP, CID_B, "", 2);
      await increaseTime(60);
      await postRegistry.connect(carol).setHead(ROOM, NO_GROUP, CID_C, "", 3);
    });

    it("Should return heads newest first from getHeads", async function () {
      const heads = await postRegistry.getHeads(ROOM);
      expect(heads.map((h) => h.by)).to.deep.equal([
        carol.address,
        bob.address,
        alice.address,
      ]);
      expect(heads[0].cid).to.equal(CID_C);
    });

    it("Should re-sort when an older writer bumps their head", async function () {
      await increaseTime(60);
      await postRegistry.setHead(ROOM, NO_GROUP, CID_A, "", 1);

      const heads = await postRegistry.getHeads(ROOM);
      expect(heads[0].by).to.equal(alice.address);
    });

    it("Should page sorted reads globally, not per page", async function () {
      const [page1, total1] = await postRegistry.getHeadsPaged(ROOM, 0, 2);
      expect(total1).to.equal(3);
      expect(page1.map((h) => h.by)).to.deep.equal([carol.address, bob.address]);

      const [page2, total2] = await postRegistry.getHeadsPaged(ROOM, 2, 2);
      expect(total2).to.equal(3);
      expect(page2.map((h) => h.by)).to.deep.equal([alice.address]);

      const [empty] = await postRegistry.getHeadsPaged(ROOM, 3, 2);
      expect(empty.length).to.equal(0);

      const [zeroLimit, totalZ] = await postRegistry.getHeadsPaged(ROOM, 0, 0);
      expect(zeroLimit.length).to.equal(0);
      expect(totalZ).to.equal(3);
    });

    it("Should return unsorted heads in first-write order", async function () {
      // The safety valve: cost depends on `limit` and nothing else, so the busiest registry on the
      // chain never becomes unreadable.
      const [refs, total] = await postRegistry.getHeadsUnsorted(ROOM, 0, 10);
      expect(total).to.equal(3);
      expect(refs.map((h) => h.by)).to.deep.equal([
        alice.address,
        bob.address,
        carol.address,
      ]);

      const [slice] = await postRegistry.getHeadsUnsorted(ROOM, 1, 1);
      expect(slice.length).to.equal(1);
      expect(slice[0].by).to.equal(bob.address);
    });

    it("Should stay callable when the sorted read would not be", async function () {
      // 40 writers is far short of the sorted read's real ceiling, but it demonstrates that the
      // unsorted path's cost tracks `limit` while the sorted path's tracks the whole set.
      const wallets = [];
      for (let i = 0; i < 40; i++) {
        const w = ethers.Wallet.createRandom().connect(ethers.provider);
        await alice.sendTransaction({ to: w.address, value: ethers.parseEther("0.05") });
        wallets.push(w);
      }
      for (const w of wallets) {
        await postRegistry.connect(w).setHead(ROOM, NO_GROUP, CID_A, "", 0);
      }

      expect(await postRegistry.writerCount(ROOM)).to.equal(43);
      const [refs, total] = await postRegistry.getHeadsUnsorted(ROOM, 0, 5);
      expect(refs.length).to.equal(5);
      expect(total).to.equal(43);
    });

    it("Should read an explicit list of writers in the order given", async function () {
      const refs = await postRegistry.headsOf(ROOM, [
        carol.address,
        stranger.address,
        alice.address,
      ]);
      expect(refs.length).to.equal(3);
      expect(refs[0].cid).to.equal(CID_C);
      expect(refs[1].movedAt).to.equal(0); // absent, not skipped — lines up with the input
      expect(refs[2].cid).to.equal(CID_A);
    });

    it("Should page the writer list", async function () {
      const [page, total] = await postRegistry.writersOf(ROOM, 1, 5);
      expect(total).to.equal(3);
      expect(page).to.deep.equal([bob.address, carol.address]);

      const [none, t] = await postRegistry.writersOf(ROOM, 9, 5);
      expect(none.length).to.equal(0);
      expect(t).to.equal(3);
    });

    it("Should read an unwritten registry as empty rather than reverting", async function () {
      const unknown = ethers.keccak256(ethers.toUtf8Bytes("nothing here"));
      expect(await postRegistry.writerCount(unknown)).to.equal(0);
      expect((await postRegistry.getHeads(unknown)).length).to.equal(0);
      const [refs, total] = await postRegistry.getHeadsUnsorted(unknown, 0, 10);
      expect(refs.length).to.equal(0);
      expect(total).to.equal(0);
    });

    it("Should serve every read to an anonymous caller with no wallet", async function () {
      // The whole point of putting the index on chain: `eth_call` from a browser with no account.
      const anon = postRegistry.connect(ethers.provider);
      expect((await anon.getHeads(ROOM)).length).to.equal(3);
      expect((await anon.headOf(ROOM, alice.address)).cid).to.equal(CID_A);
      expect((await anon.headsOf(ROOM, [bob.address]))[0].cid).to.equal(CID_B);
      const [unsorted] = await anon.getHeadsUnsorted(ROOM, 0, 3);
      expect(unsorted.length).to.equal(3);
      expect(await anon.canWrite(ROOM, alice.address)).to.be.true;
    });
  });
});
