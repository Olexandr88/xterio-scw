import { expect } from "chai";
import { ethers } from "hardhat";
import {
  SmartAccount,
  SmartAccountFactory,
  EntryPoint,
  WhitelistModule,
  EntryPoint__factory,
  VerifyingSingletonPaymaster,
  VerifyingSingletonPaymaster__factory,
  MockToken,
  MultiSend,
  StorageSetter,
  EOAOwnershipRegistryModule,
} from "../../typechain";
import {
  SafeTransaction,
  Transaction,
  FeeRefund,
  safeSignTypedData,
  buildSafeTransaction,
} from "../../src/utils/execution";
import { encodeTransfer } from "../smart-wallet/testUtils";
import { fillAndSign, fillUserOp } from "../utils/userOp";
import { arrayify, hexConcat, parseEther } from "ethers/lib/utils";
import { Signer } from "ethers";
import { UserOperation } from "../utils/userOperation";

export async function deployEntryPoint(
  provider = ethers.provider
): Promise<EntryPoint> {
  const epf = await (await ethers.getContractFactory("EntryPoint")).deploy();
  return EntryPoint__factory.connect(epf.address, provider.getSigner());
}

export const AddressZero = "0x0000000000000000000000000000000000000000";
export const AddressOne = "0x0000000000000000000000000000000000000001";

describe("Ownerless Smart Account tests", function () {
  let entryPoint: EntryPoint;
  let latestEntryPoint: EntryPoint;
  let walletOwner: Signer;
  let paymasterAddress: string;
  let offchainSigner: Signer, deployer: Signer;
  let offchainSigner2: Signer;
  let verifyingSingletonPaymaster: VerifyingSingletonPaymaster;
  let baseImpl: SmartAccount;
  let whitelistModule: WhitelistModule;
  let eoaOwnersRegistryModule: EOAOwnershipRegistryModule;
  let walletFactory: SmartAccountFactory;
  let token: MockToken;
  let multiSend: MultiSend;
  let storage: StorageSetter;
  let owner: string;
  let bob: string;
  let charlie: string;
  let newAuthority: string;
  let userSCW: any;
  let userAuthorizationModule: any;
  let accounts: any;
  let tx: any;

  before(async () => {
    accounts = await ethers.getSigners();
    entryPoint = await deployEntryPoint();

    deployer = accounts[0];
    offchainSigner = accounts[1];
    offchainSigner2 = accounts[3];
    walletOwner = deployer;

    owner = await accounts[0].getAddress();
    bob = await accounts[1].getAddress();
    charlie = await accounts[2].getAddress();
    newAuthority = await accounts[3].getAddress();

    const BaseImplementation = await ethers.getContractFactory("SmartAccount");
    baseImpl = await BaseImplementation.deploy(entryPoint.address);
    await baseImpl.deployed();
    console.log("base wallet impl deployed at: ", baseImpl.address);

    const WalletFactory = await ethers.getContractFactory(
      "SmartAccountFactory"
    );
    walletFactory = await WalletFactory.deploy(baseImpl.address);
    await walletFactory.deployed();
    console.log("wallet factory deployed at: ", walletFactory.address);

    const MockToken = await ethers.getContractFactory("MockToken");
    token = await MockToken.deploy();
    await token.deployed();
    console.log("Test token deployed at: ", token.address);

    const EOAOwnersModule = await ethers.getContractFactory("EOAOwnershipRegistryModule");
    eoaOwnersRegistryModule = await EOAOwnersModule.connect(accounts[0]).deploy();
    console.log("EOA Owners Registry Module deployed at ", eoaOwnersRegistryModule.address);

    console.log("mint tokens to owner address..");
    await token.mint(owner, ethers.utils.parseEther("1000000"));

  });

  describe("Test UserOp Validation With Authorization Module", function () {
    it("Deploys user Smart Account and Module", async () => {

      const EOAOwnershipRegistryModule = await ethers.getContractFactory("EOAOwnershipRegistryModule");
      const eoaOwner = await accounts[1].getAddress();
      
      // CREATE MODULE SETUP DATA AND DEPLOY ACCOUNT
      let eoaOwnershipSetupData = EOAOwnershipRegistryModule.interface.encodeFunctionData(
        "initForSmartAccount",
        [eoaOwner]
      );

      const expectedSmartAccountAddress =
        await walletFactory.getAddressForCounterFactualAccount(eoaOwnersRegistryModule.address, eoaOwnershipSetupData, 0);

      let smartAccountDeployTx = await walletFactory.deployCounterFactualAccount(eoaOwnersRegistryModule.address, eoaOwnershipSetupData, 0);
      expect(smartAccountDeployTx).to.emit(walletFactory, "AccountCreation")
        .withArgs(expectedSmartAccountAddress, eoaOwnersRegistryModule.address, 0);

      userSCW = await ethers.getContractAt(
        "contracts/smart-contract-wallet/SmartAccount.sol:SmartAccount",
        expectedSmartAccountAddress
      );

      //
      await accounts[0].sendTransaction({
        to: userSCW.address,
        value: ethers.utils.parseEther("10"),
      });

      console.log("mint tokens to userSCW address..");
      await token.mint(userSCW.address, ethers.utils.parseEther("1000000"));

      console.log("user module is at %s", eoaOwnersRegistryModule.address);

      expect(await userSCW.isModuleEnabled(eoaOwnersRegistryModule.address)).to.equal(true);
      expect(await eoaOwnersRegistryModule.smartAccountOwners(userSCW.address)).to.equal(eoaOwner);

      expect(await ethers.provider.getBalance(userSCW.address)).to.equal(ethers.utils.parseEther("10"));
      expect(await token.balanceOf(userSCW.address)).to.equal(ethers.utils.parseEther("1000000"));
      
    });


    it("Can send a userOp signed for the newly connected module", async () => {

      const SmartAccount = await ethers.getContractFactory("SmartAccount");
      const charlieTokenBalanceBefore = await token.balanceOf(charlie);
      const EIP1271_MAGIC_VALUE = "0x1626ba7e";

      const eoaOwner = await eoaOwnersRegistryModule.smartAccountOwners(userSCW.address);
      expect(eoaOwner).to.equal(await accounts[1].getAddress());

      let tokenAmountToTransfer = ethers.utils.parseEther("0.5345");

      const txnDataAA1 = SmartAccount.interface.encodeFunctionData(
        "executeCall",
        [
          token.address,
          ethers.utils.parseEther("0"),
          encodeTransfer(charlie, tokenAmountToTransfer.toString()),
        ]
      );

      const userOp1 = await fillAndSign(
        {
          sender: userSCW.address,
          callData: txnDataAA1,
          callGasLimit: 1_000_000,
        },
        accounts[1],  //signed by owner, that is set in the EOAOwnershipRegistryModule
        entryPoint,
        'nonce'
      );

      // add validator module address to the signature
      let signatureWithModuleAddress = ethers.utils.defaultAbiCoder.encode(
        ["bytes", "address"], 
        [userOp1.signature, eoaOwnersRegistryModule.address]
      );
      userOp1.signature = signatureWithModuleAddress;

      const handleOpsTxn = await entryPoint.handleOps([userOp1], await offchainSigner.getAddress(), {
        gasLimit: 10000000,
      });
      await handleOpsTxn.wait();

      expect(await token.balanceOf(charlie)).to.equal(charlieTokenBalanceBefore.add(tokenAmountToTransfer));
      
      // we sign userOpHash with signer.signMessage, which adds a prefix to the message
      // so we need to use 'ethers.utils.hashMessage' to get the same hash,
      // as isValidSignature expects the prefixed message hash (it doesn't prefix it itself)
      let userOp1Hash = await entryPoint.getUserOpHash(userOp1);
      const message = arrayify(userOp1Hash);
      const ethSignedUserOpHash = ethers.utils.hashMessage(message);

      expect(await userSCW.isValidSignature(ethSignedUserOpHash, signatureWithModuleAddress)).to.equal(EIP1271_MAGIC_VALUE);
    });

    it("Can use forward flow with modules", async () => {

      const EOA_CONTROLLED_FLOW = 1;
      const charlieTokenBalanceBefore = await token.balanceOf(charlie);

      let tokenAmountToTransfer = ethers.utils.parseEther("0.13924");

      const safeTx: SafeTransaction = buildSafeTransaction({
        to: token.address,
        data: encodeTransfer(charlie, tokenAmountToTransfer.toString()),
        nonce: await userSCW.getNonce(EOA_CONTROLLED_FLOW),
      });
  
      const chainId = await userSCW.getChainId();
      const { signer, data } = await safeSignTypedData(
        accounts[1], //eoa owner stored in the registry
        userSCW,
        safeTx,
        chainId
      );

      const transaction: Transaction = {
        to: safeTx.to,
        value: safeTx.value,
        data: safeTx.data,
        operation: safeTx.operation,
        targetTxGas: safeTx.targetTxGas,
      };
      const refundInfo: FeeRefund = {
        baseGas: safeTx.baseGas,
        gasPrice: safeTx.gasPrice,
        tokenGasPriceFactor: safeTx.tokenGasPriceFactor,
        gasToken: safeTx.gasToken,
        refundReceiver: safeTx.refundReceiver,
      };
  
      let signature = "0x";
      signature += data.slice(2);
      // add validator module address to the signature
      let signatureWithModuleAddress = ethers.utils.defaultAbiCoder.encode(
        ["bytes", "address"], 
        [signature, eoaOwnersRegistryModule.address]
      );
  
      await expect(
        userSCW
          .connect(accounts[0])
          .execTransaction_S6W(transaction, refundInfo, signatureWithModuleAddress)
      ).to.emit(userSCW, "ExecutionSuccess");

      expect(await token.balanceOf(charlie)).to.equal(charlieTokenBalanceBefore.add(tokenAmountToTransfer));
      
    });

    
    
  });
});
