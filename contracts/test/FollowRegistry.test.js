import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { deployPinnedUserRegistry, PINNED_USER_REGISTRY } from "./helpers/pinnedUserRegistry.js";

const DAY = 24 * 60 * 60;
const FEED = ethers.keccak256(ethers.toUtf8Bytes("feed"));
const CID_A = "bafybeid57rs2jcvyny3vfbryye6unkzg4winpidkugt27h4yzqchipku5y";

async function now() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

async function increaseTime(seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("FollowRegistry", function () {
  let userRegistry;
  let followRegistry;
  let user1;
  let user2;
  let user3;
  let user4;
  let delegate;

  beforeEach(async function () {
    [user1, user2, user3, user4, delegate] = await ethers.getSigners();

    userRegistry = await deployPinnedUserRegistry();

    const FollowRegistry = await ethers.getContractFactory("FollowRegistry");
    followRegistry = await FollowRegistry.deploy();
  });

  describe("Following", function () {
    it("Should allow a user to follow another user", async function () {
      await expect(followRegistry.connect(user1).follow(user2.address))
        .to.emit(followRegistry, "Followed")
        .withArgs(user1.address, user2.address);

      expect(await followRegistry.isFollowing(user1.address, user2.address)).to.be.true;
    });

    it("Should reject following the zero address", async function () {
      await expect(followRegistry.connect(user1).follow(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(followRegistry, "ZeroAddress");
    });

    it("Should reject following yourself", async function () {
      await expect(followRegistry.connect(user1).follow(user1.address))
        .to.be.revertedWithCustomError(followRegistry, "CannotFollowSelf");
    });

    it("Should reject a duplicate follow", async function () {
      await followRegistry.connect(user1).follow(user2.address);
      await expect(followRegistry.connect(user1).follow(user2.address))
        .to.be.revertedWithCustomError(followRegistry, "AlreadyFollowing");
    });

    it("Should record the edge in both directions", async function () {
      await followRegistry.connect(user1).follow(user2.address);
      await followRegistry.connect(user3).follow(user2.address);

      expect(await followRegistry.getFollowing(user1.address)).to.deep.equal([user2.address]);
      expect(await followRegistry.getFollowers(user2.address)).to.deep.equal([
        user1.address,
        user3.address,
      ]);
      expect(await followRegistry.getFollowingCount(user1.address)).to.equal(1);
      expect(await followRegistry.getFollowerCount(user2.address)).to.equal(2);
    });
  });

  describe("Unfollowing", function () {
    beforeEach(async function () {
      await followRegistry.connect(user1).follow(user2.address);
      await followRegistry.connect(user1).follow(user3.address);
      await followRegistry.connect(user1).follow(user4.address);
    });

    it("Should remove the edge from both sides", async function () {
      await expect(followRegistry.connect(user1).unfollow(user2.address))
        .to.emit(followRegistry, "Unfollowed")
        .withArgs(user1.address, user2.address);

      expect(await followRegistry.isFollowing(user1.address, user2.address)).to.be.false;
      expect(await followRegistry.getFollowerCount(user2.address)).to.equal(0);
      expect(await followRegistry.getFollowingCount(user1.address)).to.equal(2);
    });

    it("Should reject unfollowing someone you do not follow", async function () {
      await expect(followRegistry.connect(user2).unfollow(user3.address))
        .to.be.revertedWithCustomError(followRegistry, "NotFollowing");
    });

    it("Should keep the index consistent across swap-and-pop", async function () {
      // Removing the middle entry moves the last one into its slot; the reverse index must follow,
      // or a later unfollow corrupts a different edge.
      await followRegistry.connect(user1).unfollow(user3.address);
      expect(await followRegistry.getFollowing(user1.address)).to.deep.equal([
        user2.address,
        user4.address,
      ]);

      await followRegistry.connect(user1).unfollow(user4.address);
      expect(await followRegistry.getFollowing(user1.address)).to.deep.equal([user2.address]);
      expect(await followRegistry.isFollowing(user1.address, user2.address)).to.be.true;
    });

    it("Should allow re-following after an unfollow", async function () {
      await followRegistry.connect(user1).unfollow(user2.address);
      await followRegistry.connect(user1).follow(user2.address);
      expect(await followRegistry.isFollowing(user1.address, user2.address)).to.be.true;
    });
  });

  // The one behavioural change: a delegate names its principal instead of being reverse-resolved.
  describe("Delegated follows", function () {
    beforeEach(async function () {
      await userRegistry.connect(user1).authorizeDelegate(delegate.address, (await now()) + DAY);
    });

    it("Should credit the edge to the principal", async function () {
      await expect(followRegistry.connect(delegate).followFor(user1.address, user2.address))
        .to.emit(followRegistry, "Followed")
        .withArgs(user1.address, user2.address);

      expect(await followRegistry.isFollowing(user1.address, user2.address)).to.be.true;
      expect(await followRegistry.isFollowing(delegate.address, user2.address)).to.be.false;
      expect(await followRegistry.getFollowing(delegate.address)).to.deep.equal([]);
    });

    it("Should let a delegate unfollow for its principal", async function () {
      await followRegistry.connect(user1).follow(user2.address);
      await followRegistry.connect(delegate).unfollowFor(user1.address, user2.address);
      expect(await followRegistry.isFollowing(user1.address, user2.address)).to.be.false;
    });

    it("Should let a principal use the For variants on themselves", async function () {
      await followRegistry.connect(user1).followFor(user1.address, user2.address);
      expect(await followRegistry.isFollowing(user1.address, user2.address)).to.be.true;
    });

    it("Should reject a stranger acting for someone else", async function () {
      await expect(followRegistry.connect(user3).followFor(user1.address, user2.address))
        .to.be.revertedWithCustomError(followRegistry, "NotAuthorized")
        .withArgs(user1.address, user3.address);
    });

    it("Should stop accepting an expired delegate", async function () {
      await increaseTime(2 * DAY);
      await expect(followRegistry.connect(delegate).followFor(user1.address, user2.address))
        .to.be.revertedWithCustomError(followRegistry, "NotAuthorized");
    });

    it("Should treat a plain follow from a delegate as the delegate's own", async function () {
      // No reverse resolution any more: `follow` is always "as msg.sender". A client that means the
      // profile must say so with followFor.
      await followRegistry.connect(delegate).follow(user2.address);
      expect(await followRegistry.isFollowing(delegate.address, user2.address)).to.be.true;
      expect(await followRegistry.isFollowing(user1.address, user2.address)).to.be.false;
    });
  });

  describe("Paged reads", function () {
    beforeEach(async function () {
      await followRegistry.connect(user1).follow(user2.address);
      await followRegistry.connect(user1).follow(user3.address);
      await followRegistry.connect(user1).follow(user4.address);
    });

    it("Should page the following list", async function () {
      const [page, total] = await followRegistry.getFollowingPaged(user1.address, 1, 2);
      expect(total).to.equal(3);
      expect(page).to.deep.equal([user3.address, user4.address]);

      const [none, t] = await followRegistry.getFollowingPaged(user1.address, 5, 2);
      expect(none.length).to.equal(0);
      expect(t).to.equal(3);
    });

    it("Should page the follower list", async function () {
      const [page, total] = await followRegistry.getFollowersPaged(user2.address, 0, 10);
      expect(total).to.equal(1);
      expect(page).to.deep.equal([user1.address]);
    });
  });

  describe("Feeding PostRegistry", function () {
    it("Should compose into a two-call feed read", async function () {
      // The whole feed: the follow graph, then one batched head read. This is the integration the
      // architecture depends on, so it is worth a test rather than a comment.
      const PostRegistry = await ethers.getContractFactory("PostRegistry");
      const postRegistry = await PostRegistry.deploy();

      await followRegistry.connect(user1).follow(user2.address);
      await followRegistry.connect(user1).follow(user3.address);
      await postRegistry.connect(user2).setHead(FEED, ethers.ZeroHash, CID_A, "", 10);

      const following = await followRegistry.getFollowing(user1.address);
      // ethers v6 returns a frozen `Result`; it must be spread before being passed back in as an
      // argument, or the encoder throws "Cannot assign to read only property".
      const heads = await postRegistry.headsOf(FEED, [...following]);

      expect(heads.length).to.equal(2);
      expect(heads[0].by).to.equal(user2.address);
      expect(heads[0].cid).to.equal(CID_A);
      expect(heads[1].movedAt).to.equal(0); // user3 has posted nothing yet
    });
  });
});
