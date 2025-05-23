const { ethers, formatUnits } = require("ethers")
const { pharos, routerAddress, tokenArr } = require("../../../config/config")
const { parentPort, workerData } = require("worker_threads")
const PharosClient = require("../../pharos/pharos.services")
const { HttpsProxyAgent } = require("https-proxy-agent")
const Wallet = require("../../../utils/wallet.utils")

class Transaction {
    static encodeMultiCallData(pair, amount, walletAddress) {
        const data = ethers.AbiCoder.defaultAbiCoder().encode(
            ['address', 'address', 'uint256', 'address', 'uint256', 'uint256', 'uint256'],
            [
                tokenArr.usdt,
                tokenArr.PHRS,
                500,
                walletAddress,
                amount,
                0,
                0,
            ]
        )
        return [ethers.concat(['0x04e45aaf', data])]
    }


    static async check(hash) {
        try {
            const receipt = await pharos.rpc.getTransactionReceipt(hash)

            return {
                hash: receipt.hash,
                status: receipt.status,
                block: receipt.blockNumber
            }
        } catch (error) {
            console.error(error)
        }
    }

    static async sendToken() {
        const { wallet, proxy, token } = workerData

        const sender = new ethers.Wallet(wallet, pharos.rpc)
        const recipients = await Wallet.loadRecipientAddress()

        const agent = proxy ? new HttpsProxyAgent(proxy) : undefined

        const amount = ethers.parseEther("0.00001")

        let i = 0
        let cycle = 1
        let maxCycle = 10

        while (cycle <= maxCycle) {
            try {
                console.log(`${sender.address} sending 0.001 PHRS to ${recipients[i % recipients.length]}`)
                const tx = await sender.sendTransaction({
                    to: recipients[i % recipients.length],
                    value: amount
                })

                await tx.wait()

                const txStatus = await this.check(tx.hash)

                if (txStatus.status !== 1) {
                    console.log(`❗ ${sender.address} FAILED SENDING TOKEN!`)
                    return
                }

                console.log(`✅ ${sender.address} SUCCESSFULLY SENDING TOKEN TO ${recipients[i % recipients.length]}`)

                const report = await PharosClient.reportSendTokenTask(sender.address, token, tx.hash, agent)

                if (!report.status) {
                    parentPort.postMessage({
                        type: "failed",
                        data: `❗ ${sender.address} SUCCESSFULLY SENDING TOKEN BUT FAILED TO REPORT IT.`
                    })
                }

                i++
                parentPort.postMessage({
                    type: "success"
                })

                console.log(`[+] ${sender.address} HAS COMPLETED SENDING CYCLE [${cycle}]`)
                await new Promise(resolve => setTimeout(resolve, 50000))
            } catch (error) {
                parentPort.postMessage({
                    type: "error",
                    data: error
                })
            }

            cycle++
        }

        console.log(`✅ ${sender.address} FINISHED ${cycle - 1} CYCLE OF SENDING TOKEN`)
    }

    static async deposit(contract, value) {
        const deposit = await contract.deposit({ value: value })
        await deposit.wait()
        return
    }


    static async swapToken() {
        const { wallet } = workerData
        const sender = new ethers.Wallet(wallet, pharos.rpc)

        const erc20Abi = [
            'function balanceOf(address) view returns (uint256)',
            'function allowance(address owner, address spender) view returns (uint256)',
            'function approve(address spender, uint256 amount) public returns (bool)',
            "function deposit() payable",
            'function decimals() view returns (uint8)'
        ]

        const routerAbi = [
            {
                "inputs": [
                    {
                        "components": [
                            { "internalType": "address", "name": "tokenIn", "type": "address" },
                            { "internalType": "address", "name": "tokenOut", "type": "address" },
                            { "internalType": "uint24", "name": "fee", "type": "uint24" },
                            { "internalType": "address", "name": "recipient", "type": "address" },
                            { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
                            { "internalType": "uint256", "name": "amountOutMinimum", "type": "uint256" },
                            { "internalType": "uint160", "name": "sqrtPriceLimitX96", "type": "uint160" },
                        ],
                        "internalType": "struct IV3SwapRouter.ExactInputSingleParams",
                        "name": "params",
                        "type": "tuple",
                    },
                ],
                "name": "exactInputSingle",
                "outputs": [{ "internalType": "uint256", "name": "amountOut", "type": "uint256" }],
                "stateMutability": "payable",
                "type": "function",
            },
        ]

        const swapMode = [
            "swap", "deposit"
        ]

        const tokens = [
            tokenArr.usdc,
            tokenArr.usdt
        ]

        let cycle = 1
        let maxCycle = 10

        while (cycle <= maxCycle) {
            const mode = Math.floor(Math.random() * swapMode.length)

            try {
                switch (mode) {
                    case 0:
                        let nonce = await pharos.rpc.getTransactionCount(sender.address, "pending")
                        const router = new ethers.Contract(routerAddress, routerAbi, sender)

                        const amount = ethers.parseUnits("0.001", 18)
                        const randomTokenIndex = Math.floor(Math.random() * tokens.length)
                        const tokenOut = tokens[randomTokenIndex]

                        const tokenContract = new ethers.Contract(pharos.contractAddress, erc20Abi, sender)
                        const balance = await tokenContract.balanceOf(sender.address)
                        const allowance = await tokenContract.allowance(sender.address, routerAddress)

                        if (balance < amount) {
                            const deposit = await tokenContract.deposit({ value: amount })
                            await deposit.wait()

                            const depositReceipt = await this.check(deposit.hash)

                            if (depositReceipt.status !== 1) {
                                parentPort.postMessage({
                                    type: "failed",
                                    data: `❗ ${sender.address} HAS INSUFFICIENT AMOUNT`
                                })
                            }
                        }

                        if (allowance < amount) {
                            const approve = await tokenContract.approve(routerAddress, amount, {
                                nonce: nonce
                            })
                            await approve.wait()
                        }

                        const params = {
                            tokenIn: pharos.contractAddress,
                            tokenOut: tokenOut,
                            fee: 500,
                            recipient: sender.address,
                            amountIn: amount,
                            amountOutMinimum: 0n,
                            sqrtPriceLimitX96: 0n
                        }

                        const tx = await router.exactInputSingle(params, {
                            gasLimit: 300000,
                            nonce: nonce++
                        })

                        await tx.wait()
                        const receipt = await this.check(tx.hash)

                        if (receipt.status !== 1) {
                            parentPort.postMessage({
                                type: "failed",
                                data: `❗ ${sender.address} FAILED VERIFYING TRANSACTION HASH`
                            })
                        }

                        parentPort.postMessage({
                            type: "success",
                            data: {
                                address: sender.address,
                                hash: receipt.hash,
                                block: receipt.block
                            }
                        })

                        break

                    case 1:
                        const pharosContract = new ethers.Contract(pharos.contractAddress, erc20Abi, sender)
                        const pharosBalance = await pharosContract.balanceOf(sender.address)
                        const amountToDeposit = ethers.parseUnits("0.001", 18)

                        if (pharosBalance < amountToDeposit) {
                            parentPort.postMessage({
                                type: failed,
                                data: `❗ ${sender.address} HAS INSUFFICIENT BALANCE`
                            })
                        }

                        const deposit = await pharosContract.deposit({ value: amountToDeposit })
                        await deposit.wait()

                        const depositReceipt = await this.check(deposit.hash)

                        if (depositReceipt.status !== 1) {
                            parentPort.postMessage({
                                type: "failed",
                                data: `❗ ${sender.address} FAILED VERIFYING TRANSACTION HASH`
                            })
                        }

                        parentPort.postMessage({
                            type: "success",
                            data: {
                                address: sender.address,
                                hash: depositReceipt.hash,
                                block: depositReceipt.block
                            }
                        })
                }
                console.log(`[+] ${sender.address} HAS COMPLETED SWAP CYCLE [${cycle - 1}]`)

                await new Promise(resolve => setTimeout(resolve, 50000))
            } catch (error) {
                parentPort.postMessage({
                    type: "error",
                    data: error
                })
            }
            cycle++
        }

        console.log(`✅ ${sender.address} FINISHED ${cycle - 1} CYCLE OF SWAPPING`)
        return
    }
}

module.exports = Transaction
