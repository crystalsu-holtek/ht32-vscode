	.syntax unified
/*---------------------------------------------------------------------------------------------------------*/
/* Holtek Semiconductor Inc.                                                                               */
/*                                                                                                         */
/* Copyright (C) Holtek Semiconductor Inc.                                                                 */
/* All rights reserved.                                                                                    */
/*                                                                                                         */
/*-----------------------------------------------------------------------------------------------------------
  File Name        : startup_ht32f1xxxx_01.s
  Version          : $Rev:: 3052         $
  Date             : $Date:: 2024-02-26 #$
  Description      : Startup code.
  Notice           : This file is different with the template of Firmware Library. !! MUST CHECK AFTER SYNC !!
-----------------------------------------------------------------------------------------------------------*/

/* Supported Device */
/* ======================================== */
/* HT32F1653, HT32F1654 */
/* HT32F1655, HT32F1656 */
/* HT32F12365, HT32F12366 */
/* HT32F12345 */

/* <<< Use Configuration Wizard in Context Menu >>>                                                        */

/* // <o>  HT32 Device */
/* // <i> Select HT32 Device for the assembly setting.  */
/* // <i> Notice that the project's Asm Define has the higher priority. */
/* //      <0=> By Project Asm Define */
/* //      <1=> HT32F1653/1654/1655/1656 */
/* //      <2=> HT32F12365/12366 */
/* //      <3=> HT32F12345 */
.equ USE_HT32_CHIP_SET, 0 /* Notice that the project's Asm Define has the higher priority. */

.equ _HT32FWID, 0xFFFFFFFF
/* _HT32FWID           EQU     0x00012366 */

.equ HT32F1653_54_55_56, 1
.equ HT32F12365_66, 2
.equ HT32F12345, 3

.if USE_HT32_CHIP_SET == 0
  /* Use project's Asm Define setting (default) */
.else
#ifdef USE_HT32_CHIP
  /* Use project's Asm Define setting (higher priority than the "USE_HT32_CHIP_SET") */
#else
  /* Use "USE_HT32_CHIP_SET" in the "startup_ht32xxxxx_xx.s" file */
.equ USE_HT32_CHIP, USE_HT32_CHIP_SET
#endif
.endif

/* Amount of memory (in bytes) allocated for Stack and Heap */
/* Tailor those values to your application needs */

/* //   <o> Stack Location */
/* //       <0=> After the RW/ZI/Heap (Default) */
/* //       <1=> On the top of the SRAM (The end of the SRAM) */
.equ USE_STACK_ON_TOP, 0

/* //   <o> Stack Size (in Bytes, must 8 byte aligned) <0-131072:8> */
/* //       <i> Only meanful when the Stack Location = "After the RW/ZI/Heap" (USE_STACK_ON_TOP = 0). */
.equ Stack_Size, 1024


/* start address for the initialization values of the .data section. defined in linker script */
	.word  _sidata
/* start address for the .data section. defined in linker script */
	.word  _sdata
/* end address for the .data section. defined in linker script */
	.word  _edata
/* start address for the .bss section. defined in linker script */
	.word  _sbss
/* end address for the .bss section. defined in linker script */
	.word  _ebss

	.section ".stack","aw",%nobits
	.align  3
	.globl  __StackTop
	.globl  __StackLimit
	.globl  __HT_check_sp
__HT_check_sp:
__StackLimit:
	.if     Stack_Size
	.space  Stack_Size
	.endif
	.size __StackLimit, . - __StackLimit
__StackTop:
	.size __StackTop, . - __StackTop
.if (USE_STACK_ON_TOP  ==  1)
.equ __StackTop, 0x20000000 + USE_LIBCFG_RAM_SIZE
.else
.endif

/* //   <o>  Heap Size (in Bytes) <0-131072:8> */
.equ Heap_Size, 0

	.section ".heap","aw",%nobits
	.align  3
	.globl  __HeapBase
	.globl  _end
	.globl  __HeapLimit
	.globl  __HT_check_heap
__HT_check_heap:
__HeapBase:
_end:
	.if     Heap_Size
	.space  Heap_Size
	.endif
	.size __HeapBase, . - __HeapBase
__HeapLimit:
	.size __HeapLimit, . - __HeapLimit

	.balign 8
	.thumb

/* ******************************************************************************* */
/* Fill-up the Vector Table entries with the exceptions ISR address */
/* ******************************************************************************* */
	.section .isr_vector,"a",%progbits
	.global __interrupt_vector_cortex_m
.equ _RESERVED, 0xFFFFFFFF
	.global  __interrupt_vector_cortex_m
	.type  __interrupt_vector_cortex_m, %object
__interrupt_vector_cortex_m:
	.long __StackTop                       /* ---, 00, 0x000, Top address of Stack */
	.long Reset_Handler                      /* ---, 01, 0x004, Reset Handler */
	.long NMI_Handler                        /* ---, 02, 0x008, NMI Handler */
	.long HardFault_Handler                  /* ---, 03, 0x00C, Hard Fault Handler */
	.long MemManage_Handler                  /* ---, 04, 0x010, Memory Management Fault Handler */
	.long BusFault_Handler                   /* ---, 05, 0x014, Bus Fault Handler */
	.long UsageFault_Handler                 /* ---, 06, 0x018, Usage Fault Handler */
	.long _RESERVED                          /* ---, 07, 0x01C, Reserved */
	.long _HT32FWID                          /* ---, 08, 0x020, Reserved */
	.long _RESERVED                          /* ---, 09, 0x024, Reserved */
	.long _RESERVED                          /* ---, 10, 0x028, Reserved */
	.long SVC_Handler                        /* ---, 11, 0x02C, SVC Handler */
	.long DebugMon_Handler                   /* ---, 12, 0x030, Debug Monitor Handler */
	.long _RESERVED                          /* ---, 13, 0x034, Reserved */
	.long PendSV_Handler                     /* ---, 14, 0x038, PendSV Handler */
	.long SysTick_Handler                    /* ---, 15, 0x03C, SysTick Handler */

	.text
	.extern USB_IRQHandler
	.long USB_IRQHandler


/* Reset handler routine */
	.type	Reset_Handler, %function
	.thumb_func
Reset_Handler:
	.weak Reset_Handler
	.global Reset_Handler
	.extern SystemInit
	.extern __main
.if (USE_HT32_CHIP == HT32F1653_54_55_56)
.else
                    LDR     R0, =BootProcess
                    BLX     R0
.endif
	.syntax unified
	/* Copy the data segment initializers from flash to SRAM */
	LDR	R1, =_sidata
	LDR	R2, =_sdata
	LDR	R3, =_edata
	B	LoopCopyDataInit
	.type	CopyDataInit, %function
	.thumb_func
CopyDataInit:
	LDR	R0, [R1]
	ADDS	R1, R1, #4
	STR	R0, [R2]
	ADDS	R2, R2, #4
	.type	LoopCopyDataInit, %function
	.thumb_func
LoopCopyDataInit:
	CMP	R2, R3
	BCC	CopyDataInit
	/* Zero fill the bss segment. */
	LDR	R2, =_sbss
	LDR	R4, =_ebss
	MOVS	R3, #0
	B	LoopFillZerobss
	.type	FillZerobss, %function
	.thumb_func
FillZerobss:
	STR	R3, [R2]
	ADDS	R2, R2, #4
	.type	LoopFillZerobss, %function
	.thumb_func
LoopFillZerobss:
	CMP	R2, R4
	BCC	FillZerobss
	/* Call the clock system initialization function */
	BL	SystemInit
	/* Call static constructors */
	BL	__libc_init_array
                    LDR     R0, =main
                    BX      R0

.if (USE_HT32_CHIP == HT32F1653_54_55_56)
.else
	.type	BootProcess, %function
	.thumb_func
BootProcess:
                    LDR     R0, =0x40080300
                    LDR     R1,[R0, #0x10]
                    CMP     R1, #0
                    BNE     BP1
                    LDR     R1,[R0, #0x14]
                    CMP     R1, #0
                    BNE     BP1
                    LDR     R1,[R0, #0x18]
                    CMP     R1, #0
                    BNE     BP1
                    LDR     R1,[R0, #0x1C]
                    CMP     R1, #0
                    BEQ     BP2
BP1:                 LDR     R0, =0x40080180
                    LDR     R1,[R0, #0xC]
                    LSLS    R1, R1, #4
                    LSRS    R1, R1, #20
                    CMP     R1, #0
                    BEQ     BP3
                    CMP     R1, #1
                    BEQ     BP3
                    CMP     R1, #2
                    BEQ     BP3
BP2:                 DSB
                    LDR     R0, =0x20000000
                    LDR     R1, =0x05fa0004
                    STR     R1, [R0]
                    LDR     R1, =0xe000ed00
                    LDR     R0, =0x05fa0004
                    STR     R0, [R1, #0xC]
                    DSB
                    B       .
BP3:                 LDR     R0, =0x20000000
                    LDR     R1, [R0]
                    LDR     R0, =0x05fa0004
                    CMP     R0, R1
                    BEQ     BP4
                    BX      LR
BP4:                 LDR     R0, =0x40088100
                    LDR     R1, =0x00000001
                    STR     R1, [R0]
                    LDR     R0, =0x20000000
                    LDR     R1, =0x0
                    STR     R1, [R0]
                    BX      LR
.endif

/* Dummy Exception Handlers */
	.type	NMI_Handler, %function
	.thumb_func
NMI_Handler:
	.weak NMI_Handler
	.global NMI_Handler
                    B       .

	.type	HardFault_Handler, %function
	.thumb_func
HardFault_Handler:
	.weak HardFault_Handler
	.global HardFault_Handler
                    B       .

	.type	MemManage_Handler, %function
	.thumb_func
MemManage_Handler:
	.weak MemManage_Handler
	.global MemManage_Handler
                    B       .

	.type	BusFault_Handler, %function
	.thumb_func
BusFault_Handler:
	.weak BusFault_Handler
	.global BusFault_Handler
                    B       .

	.type	UsageFault_Handler, %function
	.thumb_func
UsageFault_Handler:
	.weak UsageFault_Handler
	.global UsageFault_Handler
                    B       .

	.type	SVC_Handler, %function
	.thumb_func
SVC_Handler:
	.weak SVC_Handler
	.global SVC_Handler
                    B       .

	.type	DebugMon_Handler, %function
	.thumb_func
DebugMon_Handler:
	.weak DebugMon_Handler
	.global DebugMon_Handler
                    B       .

	.type	PendSV_Handler, %function
	.thumb_func
PendSV_Handler:
	.weak PendSV_Handler
	.global PendSV_Handler
                    B       .

	.type	SysTick_Handler, %function
	.thumb_func
SysTick_Handler:
	.weak SysTick_Handler
	.global SysTick_Handler
                    B       .


	.balign 4

/* ******************************************************************************* */
/* User Stack and Heap initialization */
/* ******************************************************************************* */
	.global __HT_check_heap
	.global __HT_check_sp

	/* [keil2gnu] Keil __MICROLIB block removed (GNU toolchain uses __StackTop/_end) */

