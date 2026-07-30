import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { deployPinnedUserRegistry, PINNED_USER_REGISTRY } from "./helpers/pinnedUserRegistry.js";

const DAY = 24 * 60 * 60;
const VoteType = { None: 0, Up: 1, Down: 2 };

const CID_A = "bafybeid57rs2jcvyny3vfbryye6unkzg4winpidkugt27h4yzqchipku5y";
const CID_B = "bafybeigdof6hgoqmf7ycfucfxlb3zr6xeozrxpgjjjmma7d64bsht4xwda";
const BOARD = ethers.keccak256(ethers.toUtf8Bytes("board:solidity"));

async function now() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

async function increaseTime(seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("Voting", function () {
  let userRegistry;
  let voting;
  let alice;
  let bob;
  let carol;
  let delegate;
  let noProfile;
  let entityId;

  beforeEach(async function () {
    [alice, bob, carol, delegate, noProfile] = await ethers.getSigners();

    userRegistry = await deployPinnedUserRegistry();

    const Voting = await ethers.getContractFactory("Voting");
    voting = await Voting.deploy();

    await userRegistry.connect(alice).createProfile("Alice", "");
    await userRegistry.connect(bob).createProfile("Bob", "");
    await userRegistry.connect(carol).createProfile("Carol", "");

    entityId = await voting.entityIdOfCid(CID_A);
  });

  describe("Entity ids", function () {
    it("Should key a global tally on the CID", async function () {
      expect(await voting.entityIdOfCid(CID_A)).to.equal(
        ethers.keccak256(ethers.toUtf8Bytes(CID_A))
      );
      expect(await voting.entityIdOfCid(CID_A)).to.not.equal(await voting.entityIdOfCid(CID_B));
    });

    it("Should key a per-registry tally on (registry, CID)", async function () {
      const scoped = await voting.entityIdInRegistry(BOARD, CID_A);
      expect(scoped).to.equal(
        ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "string"], [BOARD, CID_A])
        )
      );
      // the same body scored on two boards is two independent tallies
      const other = await voting.entityIdInRegistry(
        ethers.keccak256(ethers.toUtf8Bytes("board:rust")),
        CID_A
      );
      expect(scoped).to.not.equal(other);
      expect(scoped).to.not.equal(await voting.entityIdOfCid(CID_A));
    });

    it("Should expose no positional entity id any more", async function () {
      // The old getEntityId(contract, entityType, index) addressed UserPosts[7]; those arrays are
      // gone and there is no index to point at.
      expect(voting.getEntityId).to.equal(undefined);
    });
  });

  describe("Voting", function () {
    it("Should upvote and downvote", async function () {
      await expect(voting.vote(entityId, VoteType.Up))
        .to.emit(voting, "Voted")
        .withArgs(entityId, alice.address, VoteType.Up, 1);

      await voting.connect(bob).vote(entityId, VoteType.Down);

      const [up, down] = await voting.getTally(entityId);
      expect(up).to.equal(1);
      expect(down).to.equal(1);
      expect(await voting.getScore(entityId)).to.equal(0);
    });

    it("Should change a vote in place, not add one", async function () {
      await voting.vote(entityId, VoteType.Up);
      await voting.vote(entityId, VoteType.Down);

      const [up, down] = await voting.getTally(entityId);
      expect(up).to.equal(0);
      expect(down).to.equal(1);
      expect(await voting.getUserVote(entityId, alice.address)).to.equal(VoteType.Down);
    });

    it("Should treat re-casting the same vote as a no-op", async function () {
      // Re-tapping the same arrow is a UI double-tap, not an error, and must not double-count.
      await voting.vote(entityId, VoteType.Up);
      await voting.vote(entityId, VoteType.Up);
      const [up] = await voting.getTally(entityId);
      expect(up).to.equal(1);
    });

    it("Should reject VoteType.None", async function () {
      await expect(voting.vote(entityId, VoteType.None))
        .to.be.revertedWithCustomError(voting, "InvalidVoteType");
    });

    it("Should require a profile", async function () {
      await expect(voting.connect(noProfile).vote(entityId, VoteType.Up))
        .to.be.revertedWithCustomError(voting, "ProfileRequired");
    });

    it("Should keep tallies independent per entity", async function () {
      const other = await voting.entityIdOfCid(CID_B);
      await voting.vote(entityId, VoteType.Up);
      await voting.vote(other, VoteType.Down);

      expect(await voting.getScore(entityId)).to.equal(1);
      expect(await voting.getScore(other)).to.equal(-1);
    });
  });

  describe("Removing a vote", function () {
    beforeEach(async function () {
      await voting.vote(entityId, VoteType.Up);
    });

    it("Should free the row and update the tally", async function () {
      await expect(voting.removeVote(entityId))
        .to.emit(voting, "VoteRemoved")
        .withArgs(entityId, alice.address, 0);

      expect(await voting.hasVoted(entityId, alice.address)).to.be.false;
      expect(await voting.getScore(entityId)).to.equal(0);
    });

    it("Should reject removing a vote that was never cast", async function () {
      await expect(voting.connect(bob).removeVote(entityId))
        .to.be.revertedWithCustomError(voting, "NotVoted");
    });

    it("Should let the voter re-vote afterwards", async function () {
      await voting.removeVote(entityId);
      await voting.vote(entityId, VoteType.Down);
      expect(await voting.getScore(entityId)).to.equal(-1);
    });

    it("Should offer no delegated or admin un-vote", async function () {
      // Same reason PostRegistry has no clearHeadFor: freeing storage pays the refund to whoever
      // freed it, so a delegated un-vote would hand a delegate the voter's deposit.
      expect(voting.removeVoteFor).to.equal(undefined);
      expect(voting.clearVotes).to.equal(undefined);
      expect(voting.owner).to.equal(undefined);
    });
  });

  describe("Delegated voting", function () {
    it("Should credit the vote to the principal, not the signer", async function () {
      await userRegistry.connect(bob).authorizeDelegate(delegate.address, (await now()) + DAY);

      await expect(voting.connect(delegate).voteFor(bob.address, entityId, VoteType.Up))
        .to.emit(voting, "Voted")
        .withArgs(entityId, bob.address, VoteType.Up, 1);

      expect(await voting.getUserVote(entityId, bob.address)).to.equal(VoteType.Up);
      expect(await voting.getUserVote(entityId, delegate.address)).to.equal(VoteType.None);
    });

    it("Should let a principal use voteFor on themselves", async function () {
      await voting.voteFor(alice.address, entityId, VoteType.Up);
      expect(await voting.getUserVote(entityId, alice.address)).to.equal(VoteType.Up);
    });

    it("Should reject a stranger voting for someone else", async function () {
      await expect(voting.connect(carol).voteFor(bob.address, entityId, VoteType.Up))
        .to.be.revertedWithCustomError(voting, "NotAuthorized")
        .withArgs(bob.address, carol.address);
    });

    it("Should stop accepting an expired delegate", async function () {
      await userRegistry.connect(bob).authorizeDelegate(delegate.address, (await now()) + 100);
      await voting.connect(delegate).voteFor(bob.address, entityId, VoteType.Up);

      await increaseTime(200);
      await expect(voting.connect(delegate).voteFor(bob.address, entityId, VoteType.Down))
        .to.be.revertedWithCustomError(voting, "NotAuthorized");

      // the vote already cast stays Bob's
      expect(await voting.getUserVote(entityId, bob.address)).to.equal(VoteType.Up);
    });

    it("Should require the PRINCIPAL to have a profile, not the delegate", async function () {
      await userRegistry
        .connect(noProfile)
        .authorizeDelegate(delegate.address, (await now()) + DAY);
      await expect(voting.connect(delegate).voteFor(noProfile.address, entityId, VoteType.Up))
        .to.be.revertedWithCustomError(voting, "ProfileRequired");
    });
  });

  describe("Batch reads", function () {
    it("Should return tallies and a user's votes for a screenful at once", async function () {
      const idA = await voting.entityIdOfCid(CID_A);
      const idB = await voting.entityIdOfCid(CID_B);
      const idC = await voting.entityIdInRegistry(BOARD, CID_A);

      await voting.vote(idA, VoteType.Up);
      await voting.connect(bob).vote(idA, VoteType.Up);
      await voting.vote(idB, VoteType.Down);

      const tallies = await voting.getTallies([idA, idB, idC]);
      expect(tallies[0].upvotes).to.equal(2);
      expect(tallies[1].downvotes).to.equal(1);
      expect(tallies[2].upvotes).to.equal(0); // untouched, returned as zero rather than skipped

      const mine = await voting.getUserVotes([idA, idB, idC], alice.address);
      expect(mine).to.deep.equal([VoteType.Up, VoteType.Down, VoteType.None]);
    });

    it("Should serve reads to an anonymous caller", async function () {
      await voting.vote(entityId, VoteType.Up);
      const anon = voting.connect(ethers.provider);
      expect(await anon.getScore(entityId)).to.equal(1);
      expect((await anon.getTallies([entityId]))[0].upvotes).to.equal(1);
    });
  });
});
