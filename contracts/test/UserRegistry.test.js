import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

const DAY = 24 * 60 * 60;
const MAX_DELEGATION_SECONDS = 90 * DAY;

async function now() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

async function increaseTime(seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("UserRegistry", function () {
  let userRegistry;
  let owner;
  let addr1;
  let addr2;
  let delegate;

  beforeEach(async function () {
    [owner, addr1, addr2, delegate] = await ethers.getSigners();
    const UserRegistry = await ethers.getContractFactory("UserRegistry");
    userRegistry = await UserRegistry.deploy();
  });

  describe("Profile Creation", function () {
    it("Should create a profile successfully", async function () {
      await expect(userRegistry.createProfile("Alice", "Hello world"))
        .to.emit(userRegistry, "ProfileCreated")
        .withArgs(owner.address);

      const profile = await userRegistry.getProfile(owner.address);
      expect(profile.displayName).to.equal("Alice");
      expect(profile.bio).to.equal("Hello world");
      expect(profile.exists).to.be.true;
    });

    it("Should reject empty display name", async function () {
      await expect(userRegistry.createProfile("", "Bio"))
        .to.be.revertedWithCustomError(userRegistry, "DisplayNameRequired");
    });

    it("Should reject display name too long", async function () {
      await expect(userRegistry.createProfile("a".repeat(51), "Bio"))
        .to.be.revertedWithCustomError(userRegistry, "TooLong")
        .withArgs(51, 50);
    });

    it("Should reject bio too long", async function () {
      await expect(userRegistry.createProfile("Alice", "a".repeat(501)))
        .to.be.revertedWithCustomError(userRegistry, "TooLong")
        .withArgs(501, 500);
    });

    it("Should reject duplicate profile creation", async function () {
      await userRegistry.createProfile("Alice", "Bio");
      await expect(userRegistry.createProfile("Alice2", "Bio2"))
        .to.be.revertedWithCustomError(userRegistry, "ProfileExists");
    });

    it("Should check hasProfile correctly", async function () {
      expect(await userRegistry.hasProfile(owner.address)).to.be.false;
      await userRegistry.createProfile("Alice", "Bio");
      expect(await userRegistry.hasProfile(owner.address)).to.be.true;
    });

    it("Should create profile with address-derived name", async function () {
      await userRegistry.createDefaultProfile();
      const profile = await userRegistry.getProfile(owner.address);
      expect(profile.displayName).to.match(/^0x[a-f0-9]{8}$/i);
      expect(profile.bio).to.equal("");
    });

    it("Should read many profiles in one call", async function () {
      await userRegistry.createProfile("Alice", "A");
      await userRegistry.connect(addr1).createProfile("Bob", "B");

      const result = await userRegistry.getProfiles([
        owner.address,
        addr1.address,
        addr2.address,
      ]);
      expect(result.length).to.equal(3);
      expect(result[0].displayName).to.equal("Alice");
      expect(result[1].displayName).to.equal("Bob");
      expect(result[2].exists).to.be.false; // absent rather than skipped
    });
  });

  describe("Profile Updates", function () {
    beforeEach(async function () {
      await userRegistry.createProfile("Alice", "Hello world");
    });

    it("Should update display name", async function () {
      await expect(userRegistry.setDisplayName("NewAlice"))
        .to.emit(userRegistry, "DisplayNameUpdated")
        .withArgs(owner.address, "NewAlice");
    });

    it("Should update bio", async function () {
      await expect(userRegistry.setBio("New bio"))
        .to.emit(userRegistry, "BioUpdated")
        .withArgs(owner.address, "New bio");
    });

    it("Should reject update from a non-owner", async function () {
      await expect(userRegistry.connect(addr1).setDisplayName("Hacker"))
        .to.be.revertedWithCustomError(userRegistry, "NoProfile")
        .withArgs(addr1.address);
    });

    it("Should NOT let a delegate rename its principal", async function () {
      await userRegistry.authorizeDelegate(delegate.address, (await now()) + DAY);
      // setDisplayName is owner-only on purpose: a leaked convenience key must not be able to
      // rename the account it serves.
      await expect(userRegistry.connect(delegate).setDisplayName("Impostor"))
        .to.be.revertedWithCustomError(userRegistry, "NoProfile");
    });
  });

  describe("Links Management", function () {
    beforeEach(async function () {
      await userRegistry.createProfile("Alice", "Hello world");
    });

    it("Should add a link", async function () {
      await expect(
        userRegistry.addLink(owner.address, "Twitter", "https://twitter.com/alice")
      )
        .to.emit(userRegistry, "LinkAdded")
        .withArgs(owner.address, 0, "Twitter", "https://twitter.com/alice");

      const links = await userRegistry.getLinks(owner.address);
      expect(links.length).to.equal(1);
      expect(links[0].name).to.equal("Twitter");
    });

    it("Should remove a link", async function () {
      await userRegistry.addLink(owner.address, "Twitter", "https://t.co/a");
      await userRegistry.addLink(owner.address, "GitHub", "https://gh.com/a");

      await expect(userRegistry.removeLink(owner.address, 0))
        .to.emit(userRegistry, "LinkRemoved")
        .withArgs(owner.address, 0);

      const links = await userRegistry.getLinks(owner.address);
      expect(links.length).to.equal(1);
      expect(links[0].name).to.equal("GitHub"); // swap-and-pop reorders
    });

    it("Should clear all links", async function () {
      await userRegistry.addLink(owner.address, "Twitter", "https://t.co/a");
      await expect(userRegistry.clearLinks(owner.address))
        .to.emit(userRegistry, "LinksCleared")
        .withArgs(owner.address);
      expect(await userRegistry.getLinkCount(owner.address)).to.equal(0);
    });

    it("Should reject more than 10 links", async function () {
      for (let i = 0; i < 10; i++) {
        await userRegistry.addLink(owner.address, `Link${i}`, `https://e.com/${i}`);
      }
      await expect(userRegistry.addLink(owner.address, "Link10", "https://e.com/10"))
        .to.be.revertedWithCustomError(userRegistry, "TooManyLinks")
        .withArgs(10);
    });

    it("Should let a live delegate manage links", async function () {
      await userRegistry.authorizeDelegate(delegate.address, (await now()) + DAY);
      await userRegistry.connect(delegate).addLink(owner.address, "Site", "https://a.dev");

      const links = await userRegistry.getLinks(owner.address);
      expect(links.length).to.equal(1);
    });

    it("Should reject link writes from a stranger", async function () {
      await expect(
        userRegistry.connect(addr1).addLink(owner.address, "Spam", "https://spam")
      )
        .to.be.revertedWithCustomError(userRegistry, "NotAuthorized")
        .withArgs(owner.address, addr1.address);
    });
  });

  // The delegation model is the substantive change from the previous version: expiry with an
  // enforced maximum, per-owner (not global) uniqueness, and no reverse lookup.
  describe("Delegation", function () {
    it("Should authorize a delegate with an expiry", async function () {
      const expiry = (await now()) + DAY;
      await expect(userRegistry.authorizeDelegate(delegate.address, expiry))
        .to.emit(userRegistry, "DelegateAuthorized")
        .withArgs(owner.address, delegate.address, expiry);

      expect(await userRegistry.delegateExpiry(owner.address, delegate.address)).to.equal(expiry);
      expect(await userRegistry.isDelegate(owner.address, delegate.address)).to.be.true;
      expect(await userRegistry.canActAs(delegate.address, owner.address)).to.be.true;
    });

    it("Should not require a profile to authorize", async function () {
      // Onboarding must not be order-dependent: authorising the session key before picking a
      // display name would otherwise cost a second prompt.
      expect(await userRegistry.hasProfile(owner.address)).to.be.false;
      await userRegistry.authorizeDelegate(delegate.address, (await now()) + DAY);
      expect(await userRegistry.isDelegate(owner.address, delegate.address)).to.be.true;
    });

    it("Should stop authorizing once the expiry passes", async function () {
      const expiry = (await now()) + 100;
      await userRegistry.authorizeDelegate(delegate.address, expiry);
      expect(await userRegistry.isDelegate(owner.address, delegate.address)).to.be.true;

      await increaseTime(101);

      expect(await userRegistry.isDelegate(owner.address, delegate.address)).to.be.false;
      expect(await userRegistry.canActAs(delegate.address, owner.address)).to.be.false;
      await expect(
        userRegistry.connect(delegate).addLink(owner.address, "Late", "https://late")
      ).to.be.revertedWithCustomError(userRegistry, "NotAuthorized");
    });

    it("Should treat the expiry second itself as expired", async function () {
      // `block.timestamp < expiry` — the boundary is exclusive, so an expiry equal to now is dead.
      const expiry = (await now()) + 10;
      await userRegistry.authorizeDelegate(delegate.address, expiry);
      await ethers.provider.send("evm_setNextBlockTimestamp", [expiry]);
      await ethers.provider.send("evm_mine", []);
      expect(await userRegistry.isDelegate(owner.address, delegate.address)).to.be.false;
    });

    it("Should reject an expiry in the past", async function () {
      const past = (await now()) - 1;
      await expect(userRegistry.authorizeDelegate(delegate.address, past))
        .to.be.revertedWithCustomError(userRegistry, "ExpiryInPast");
    });

    it("Should reject an expiry beyond the maximum rather than clamping it", async function () {
      // Reverting is deliberate: a client that guesses high must fail loudly instead of silently
      // receiving less authority than it asked for.
      const tooFar = (await now()) + MAX_DELEGATION_SECONDS + 1000;
      await expect(userRegistry.authorizeDelegate(delegate.address, tooFar))
        .to.be.revertedWithCustomError(userRegistry, "ExpiryTooFar");
    });

    it("Should accept an expiry exactly at the maximum", async function () {
      const next = (await now()) + 1;
      await ethers.provider.send("evm_setNextBlockTimestamp", [next]);
      const expiry = next + MAX_DELEGATION_SECONDS;
      await userRegistry.authorizeDelegate(delegate.address, expiry);
      expect(await userRegistry.delegateExpiry(owner.address, delegate.address)).to.equal(expiry);
    });

    it("Should expose MAX_DELEGATION_SECONDS as 90 days", async function () {
      expect(await userRegistry.MAX_DELEGATION_SECONDS()).to.equal(MAX_DELEGATION_SECONDS);
    });

    it("Should let re-authorizing extend and shorten the expiry", async function () {
      const first = (await now()) + DAY;
      await userRegistry.authorizeDelegate(delegate.address, first);

      const longer = first + DAY;
      await userRegistry.authorizeDelegate(delegate.address, longer);
      expect(await userRegistry.delegateExpiry(owner.address, delegate.address)).to.equal(longer);

      const shorter = (await now()) + 60;
      await userRegistry.authorizeDelegate(delegate.address, shorter);
      expect(await userRegistry.delegateExpiry(owner.address, delegate.address)).to.equal(shorter);
    });

    it("Should treat expiry 0 as a revoke", async function () {
      await userRegistry.authorizeDelegate(delegate.address, (await now()) + DAY);
      await expect(userRegistry.authorizeDelegate(delegate.address, 0))
        .to.emit(userRegistry, "DelegateRevoked")
        .withArgs(owner.address, delegate.address);
      expect(await userRegistry.isDelegate(owner.address, delegate.address)).to.be.false;
    });

    it("Should revoke a live delegation", async function () {
      await userRegistry.authorizeDelegate(delegate.address, (await now()) + DAY);
      await expect(userRegistry.revokeDelegate(delegate.address))
        .to.emit(userRegistry, "DelegateRevoked")
        .withArgs(owner.address, delegate.address);
      expect(await userRegistry.delegateExpiry(owner.address, delegate.address)).to.equal(0);
    });

    it("Should make revoke idempotent", async function () {
      // A revocation that errors because the desired state already holds is a UI that tells the
      // user their key is still live when it is not.
      await expect(userRegistry.revokeDelegate(delegate.address)).to.not.be.reverted;
    });

    it("Should not let a delegate revoke itself", async function () {
      await userRegistry.authorizeDelegate(delegate.address, (await now()) + DAY);
      // The delegate revoking its own row would free storage it did not pay for.
      await userRegistry.connect(delegate).revokeDelegate(owner.address);
      expect(await userRegistry.isDelegate(owner.address, delegate.address)).to.be.true;
    });

    it("Should reject the zero address and self-delegation", async function () {
      await expect(userRegistry.authorizeDelegate(ethers.ZeroAddress, (await now()) + DAY))
        .to.be.revertedWithCustomError(userRegistry, "ZeroDelegate");
      await expect(userRegistry.authorizeDelegate(owner.address, (await now()) + DAY))
        .to.be.revertedWithCustomError(userRegistry, "SelfDelegate");
    });

    it("Should allow the SAME delegate address for two different owners", async function () {
      // The point of the relaxation: delegate keys are derived, so the same address legitimately
      // serves two profiles belonging to one person. The old global-uniqueness check made the
      // second profile unable to authorise its own session key at all.
      const expiry = (await now()) + DAY;
      await userRegistry.authorizeDelegate(delegate.address, expiry);
      await userRegistry.connect(addr1).authorizeDelegate(delegate.address, expiry);

      expect(await userRegistry.canActAs(delegate.address, owner.address)).to.be.true;
      expect(await userRegistry.canActAs(delegate.address, addr1.address)).to.be.true;
    });

    it("Should keep delegation one-directional", async function () {
      await userRegistry.authorizeDelegate(delegate.address, (await now()) + DAY);
      expect(await userRegistry.canActAs(owner.address, delegate.address)).to.be.false;
    });

    it("Should report canActAs(x, x) as true without any delegation", async function () {
      expect(await userRegistry.canActAs(owner.address, owner.address)).to.be.true;
      expect(await userRegistry.isDelegate(owner.address, owner.address)).to.be.false;
    });

    it("Should expose no reverse delegate lookup", async function () {
      // Dropping `delegateToOwner`/`resolveToOwner` is what makes per-owner uniqueness sound: with
      // one address serving two owners there is no correct answer, only a guess that misattributes.
      expect(userRegistry.delegateToOwner).to.equal(undefined);
      expect(userRegistry.resolveToOwner).to.equal(undefined);
    });
  });

  describe("Session keys are gone", function () {
    it("Should expose no session-public-key surface at all", async function () {
      expect(userRegistry.setSessionPublicKey).to.equal(undefined);
      expect(userRegistry.getSessionPublicKey).to.equal(undefined);
      expect(userRegistry.sessionPublicKeys).to.equal(undefined);
      expect(userRegistry.hasSessionPublicKey).to.equal(undefined);
    });
  });

  describe("Profile Ownership Transfer", function () {
    beforeEach(async function () {
      await userRegistry.createProfile("Alice", "Original bio");
      await userRegistry.addLink(owner.address, "Twitter", "https://t.co/a");
    });

    it("Should transfer the profile and its links", async function () {
      await expect(userRegistry.transferProfileOwnership(addr1.address))
        .to.emit(userRegistry, "ProfileOwnershipTransferred")
        .withArgs(owner.address, addr1.address);

      const newProfile = await userRegistry.getProfile(addr1.address);
      expect(newProfile.displayName).to.equal("Alice");
      expect((await userRegistry.getLinks(addr1.address)).length).to.equal(1);

      expect((await userRegistry.getProfile(owner.address)).exists).to.be.false;
      expect((await userRegistry.getLinks(owner.address)).length).to.equal(0);
    });

    it("Should NOT carry delegations across a transfer", async function () {
      await userRegistry.authorizeDelegate(delegate.address, (await now()) + DAY);
      await userRegistry.transferProfileOwnership(addr1.address);
      expect(await userRegistry.canActAs(delegate.address, addr1.address)).to.be.false;
    });

    it("Should reject bad targets", async function () {
      await expect(userRegistry.transferProfileOwnership(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(userRegistry, "InvalidNewOwner");
      await expect(userRegistry.transferProfileOwnership(owner.address))
        .to.be.revertedWithCustomError(userRegistry, "InvalidNewOwner");

      await userRegistry.connect(addr1).createProfile("Bob", "Bio");
      await expect(userRegistry.transferProfileOwnership(addr1.address))
        .to.be.revertedWithCustomError(userRegistry, "ProfileExists");
    });

    it("Should reject transfer from a non-owner", async function () {
      await expect(userRegistry.connect(addr2).transferProfileOwnership(addr1.address))
        .to.be.revertedWithCustomError(userRegistry, "NoProfile");
    });

    it("Should never be delegable", async function () {
      await userRegistry.authorizeDelegate(delegate.address, (await now()) + DAY);
      await expect(userRegistry.connect(delegate).transferProfileOwnership(addr2.address))
        .to.be.revertedWithCustomError(userRegistry, "NoProfile");
    });
  });
});
