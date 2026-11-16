# Warm-up C
import asyncio


async def a():
    print('C1')
    await asyncio.sleep(0)
    print('C2')


async def b():
    print('C3')
    await asyncio.sleep(0)
    print('C4')


async def main():
    await asyncio.gather(a(), b())


asyncio.run(main())
