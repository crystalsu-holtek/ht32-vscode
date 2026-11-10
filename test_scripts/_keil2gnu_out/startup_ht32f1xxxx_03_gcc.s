	.syntax unified
/*---------------------------------------------------------------------------------------------------------*/
/* Holtek Semiconductor Inc.                                                                               */
/*                                                                                                         */
/* Copyright (C) Holtek Semiconductor Inc.                                                                 */
/* All rights reserved.                                                                                    */
/*                                                                                                         */
/*-----------------------------------------------------------------------------------------------------------
  File Name        : startup_ht32f1xxxx_03.s
  Version          : $Rev:: 3052         $
  Date             : $Date:: 2024-02-26 #$
  Description      : Startup code.
  Notice           : This file is different with the template of Firmware Library. !! MUST CHECK AFTER SYNC !!
-----------------------------------------------------------------------------------------------------------*/

/* Supported Device */
/* ======================================== */
/* HT32F12364 */

/* <<< Use Configuration Wizard in Context Menu >>>                                                        */

/* // <o>  HT32 Device */
/* // <i> Select HT32 Device for the assembly setting.  */
/* // <i> Notice that the project's Asm Define has the higher priority. */
/* //      <0=> By Project Asm Define */
/* //      <16=> HT32F12364 */
.equ USE_HT32_CHIP_SET, 0 /* Notice that the project's Asm Define has the higher priority. */

.equ _HT32FWID, 0xFFFFFFFF
/* _HT32FWID           EQU     0x00012364 */

.equ HT32F12364, 16

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
	.include "image_info_gcc.s"
                    /* DCD  _RESERVED                          ; ---, 04, 0x010, Reserved */
                    /* DCD  _RESERVED                          ; ---, 05, 0x014, Reserved */
                    /* DCD  _RESERVED                          ; ---, 06, 0x018, Reserved */
                    /* DCD  _RESERVED                          ; ---, 07, 0x01C, Reserved */
                    /* DCD  _HT32FWID                          ; ---, 08, 0x020, Reserved */
                    /* DCD  _RESERVED                          ; ---, 09, 0x024, Reserved */
	.long _RESERVED                          /* ---, 10, 0x028, Reserved */
	.long SVC_Handler                        /* ---, 11, 0x02C, SVC Handler */
	.long DebugMon_Handler                   /* ---, 12, 0x030, Debug Monitor Handler */
	.long _RESERVED                          /* ---, 13, 0x034, Reserved */
	.long PendSV_Handler                     /* ---, 14, 0x038, PendSV Handler */
	.long SysTick_Handler                    /* ---, 15, 0x03C, SysTick Handler */

                    /* External Interrupt Handler */
	.long CKRDY_IRQHandler                   /* 00, 16, 0x040, */
	.long LVD_IRQHandler                     /* 01, 17, 0x044, */
	.long BOD_IRQHandler                     /* 02, 18, 0x048, */
	.long _RESERVED                          /* 03, 19, 0x04C, */
	.long RTC_IRQHandler                     /* 04, 20, 0x050, */
	.long FLASH_IRQHandler                   /* 05, 21, 0x054, */
	.long EVWUP_IRQHandler                   /* 06, 22, 0x058, */
	.long LPWUP_IRQHandler                   /* 07, 23, 0x05C, */
	.long EXTI0_IRQHandler                   /* 08, 24, 0x060, */
	.long EXTI1_IRQHandler                   /* 09, 25, 0x064, */
	.long EXTI2_IRQHandler                   /* 10, 26, 0x068, */
	.long EXTI3_IRQHandler                   /* 11, 27, 0x06C, */
	.long EXTI4_IRQHandler                   /* 12, 28, 0x070, */
	.long EXTI5_IRQHandler                   /* 13, 29, 0x074, */
	.long EXTI6_IRQHandler                   /* 14, 30, 0x078, */
	.long EXTI7_IRQHandler                   /* 15, 31, 0x07C, */
	.long EXTI8_IRQHandler                   /* 16, 32, 0x080, */
	.long EXTI9_IRQHandler                   /* 17, 33, 0x084, */
	.long EXTI10_IRQHandler                  /* 18, 34, 0x088, */
	.long EXTI11_IRQHandler                  /* 19, 35, 0x08C, */
	.long EXTI12_IRQHandler                  /* 20, 36, 0x090, */
	.long EXTI13_IRQHandler                  /* 21, 37, 0x094, */
	.long EXTI14_IRQHandler                  /* 22, 38, 0x098, */
	.long EXTI15_IRQHandler                  /* 23, 39, 0x09C, */
	.long _RESERVED                          /* 24, 40, 0x0A0, */
	.long ADC_IRQHandler                     /* 25, 41, 0x0A4, */
	.long _RESERVED                          /* 26, 42, 0x0A8, */
	.long _RESERVED                          /* 27, 43, 0x0AC, */
	.long _RESERVED                          /* 28, 44, 0x0B0, */
	.long _RESERVED                          /* 29, 45, 0x0B4, */
	.long _RESERVED                          /* 30, 46, 0x0B8, */
	.long _RESERVED                          /* 31, 47, 0x0BC, */
	.long _RESERVED                          /* 32, 48, 0x0C0, */
	.long _RESERVED                          /* 33, 49, 0x0C4, */
	.long _RESERVED                          /* 34, 50, 0x0C8, */
	.long GPTM0_IRQHandler                   /* 35, 51, 0x0CC, */
	.long _RESERVED                          /* 36, 52, 0x0D0, */
	.long SCTM0_IRQHandler                   /* 37, 53, 0x0D4, */
	.long SCTM1_IRQHandler                   /* 38, 54, 0x0D8, */
	.long PWM0_IRQHandler                    /* 39, 55, 0x0DC, */
	.long _RESERVED                          /* 40, 56, 0x0E0, */
	.long BFTM0_IRQHandler                   /* 41, 57, 0x0E4, */
	.long BFTM1_IRQHandler                   /* 42, 58, 0x0E8, */
	.long I2C0_IRQHandler                    /* 43, 59, 0x0EC, */
	.long I2C1_IRQHandler                    /* 44, 60, 0x0F0, */
	.long SPI0_IRQHandler                    /* 45, 61, 0x0F4, */
	.long SPI1_IRQHandler                    /* 46, 62, 0x0F8, */
	.long USART0_IRQHandler                  /* 47, 63, 0x0FC, */
	.long _RESERVED                          /* 48, 64, 0x100, */
	.long UART0_IRQHandler                   /* 49, 65, 0x104, */
	.long UART1_IRQHandler                   /* 50, 66, 0x108, */
	.long SCI_IRQHandler                     /* 51, 67, 0x10C, */
	.long _RESERVED                          /* 52, 68, 0x110, */
	.long USB_IRQHandler                     /* 53, 69, 0x114, */
	.long _RESERVED                          /* 54, 70, 0x118, */
	.long PDMA_CH0_IRQHandler                /* 55, 71, 0x11C, */
	.long PDMA_CH1_IRQHandler                /* 56, 72, 0x120, */
	.long PDMA_CH2_IRQHandler                /* 57, 73, 0x124, */
	.long PDMA_CH3_IRQHandler                /* 58, 74, 0x128, */
	.long PDMA_CH4_IRQHandler                /* 59, 75, 0x12C, */
	.long PDMA_CH5_IRQHandler                /* 60, 76, 0x130, */
	.long _RESERVED                          /* 61, 77, 0x134, */
	.long _RESERVED                          /* 62, 78, 0x138, */
	.long _RESERVED                          /* 63, 79, 0x13C, */
	.long _RESERVED                          /* 64, 80, 0x140, */
	.long _RESERVED                          /* 65, 81, 0x144, */
	.long _RESERVED                          /* 66, 82, 0x148, */
	.long _RESERVED                          /* 67, 83, 0x14C, */
	.long _RESERVED                          /* 68, 84, 0x150, */
	.long AES_IRQHandler                     /* 69, 85, 0x154, */

/* Reset handler routine */
	.type	Reset_Handler, %function
	.thumb_func
Reset_Handler:
	.weak Reset_Handler
	.global Reset_Handler
	.extern SystemInit
	.extern __main
                    LDR     R0, =BootProcess
                    BLX     R0
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

	.type	Default_Handler, %function
	.thumb_func
Default_Handler:
	.weak CKRDY_IRQHandler
	.global CKRDY_IRQHandler
	.weak LVD_IRQHandler
	.global LVD_IRQHandler
	.weak BOD_IRQHandler
	.global BOD_IRQHandler
	.weak RTC_IRQHandler
	.global RTC_IRQHandler
	.weak FLASH_IRQHandler
	.global FLASH_IRQHandler
	.weak EVWUP_IRQHandler
	.global EVWUP_IRQHandler
	.weak LPWUP_IRQHandler
	.global LPWUP_IRQHandler
	.weak EXTI0_IRQHandler
	.global EXTI0_IRQHandler
	.weak EXTI1_IRQHandler
	.global EXTI1_IRQHandler
	.weak EXTI2_IRQHandler
	.global EXTI2_IRQHandler
	.weak EXTI3_IRQHandler
	.global EXTI3_IRQHandler
	.weak EXTI4_IRQHandler
	.global EXTI4_IRQHandler
	.weak EXTI5_IRQHandler
	.global EXTI5_IRQHandler
	.weak EXTI6_IRQHandler
	.global EXTI6_IRQHandler
	.weak EXTI7_IRQHandler
	.global EXTI7_IRQHandler
	.weak EXTI8_IRQHandler
	.global EXTI8_IRQHandler
	.weak EXTI9_IRQHandler
	.global EXTI9_IRQHandler
	.weak EXTI10_IRQHandler
	.global EXTI10_IRQHandler
	.weak EXTI11_IRQHandler
	.global EXTI11_IRQHandler
	.weak EXTI12_IRQHandler
	.global EXTI12_IRQHandler
	.weak EXTI13_IRQHandler
	.global EXTI13_IRQHandler
	.weak EXTI14_IRQHandler
	.global EXTI14_IRQHandler
	.weak EXTI15_IRQHandler
	.global EXTI15_IRQHandler
	.weak ADC_IRQHandler
	.global ADC_IRQHandler
	.weak GPTM0_IRQHandler
	.global GPTM0_IRQHandler
	.weak SCTM0_IRQHandler
	.global SCTM0_IRQHandler
	.weak SCTM1_IRQHandler
	.global SCTM1_IRQHandler
	.weak PWM0_IRQHandler
	.global PWM0_IRQHandler
	.weak BFTM0_IRQHandler
	.global BFTM0_IRQHandler
	.weak BFTM1_IRQHandler
	.global BFTM1_IRQHandler
	.weak I2C0_IRQHandler
	.global I2C0_IRQHandler
	.weak I2C1_IRQHandler
	.global I2C1_IRQHandler
	.weak SPI0_IRQHandler
	.global SPI0_IRQHandler
	.weak SPI1_IRQHandler
	.global SPI1_IRQHandler
	.weak USART0_IRQHandler
	.global USART0_IRQHandler
	.weak UART0_IRQHandler
	.global UART0_IRQHandler
	.weak UART1_IRQHandler
	.global UART1_IRQHandler
	.weak SCI_IRQHandler
	.global SCI_IRQHandler
	.weak USB_IRQHandler
	.global USB_IRQHandler
	.weak PDMA_CH0_IRQHandler
	.global PDMA_CH0_IRQHandler
	.weak PDMA_CH1_IRQHandler
	.global PDMA_CH1_IRQHandler
	.weak PDMA_CH2_IRQHandler
	.global PDMA_CH2_IRQHandler
	.weak PDMA_CH3_IRQHandler
	.global PDMA_CH3_IRQHandler
	.weak PDMA_CH4_IRQHandler
	.global PDMA_CH4_IRQHandler
	.weak PDMA_CH5_IRQHandler
	.global PDMA_CH5_IRQHandler
	.weak AES_IRQHandler
	.global AES_IRQHandler
	.type	CKRDY_IRQHandler, %function
	.thumb_func
CKRDY_IRQHandler:
	.type	LVD_IRQHandler, %function
	.thumb_func
LVD_IRQHandler:
	.type	BOD_IRQHandler, %function
	.thumb_func
BOD_IRQHandler:
	.type	RTC_IRQHandler, %function
	.thumb_func
RTC_IRQHandler:
	.type	FLASH_IRQHandler, %function
	.thumb_func
FLASH_IRQHandler:
	.type	EVWUP_IRQHandler, %function
	.thumb_func
EVWUP_IRQHandler:
	.type	LPWUP_IRQHandler, %function
	.thumb_func
LPWUP_IRQHandler:
	.type	EXTI0_IRQHandler, %function
	.thumb_func
EXTI0_IRQHandler:
	.type	EXTI1_IRQHandler, %function
	.thumb_func
EXTI1_IRQHandler:
	.type	EXTI2_IRQHandler, %function
	.thumb_func
EXTI2_IRQHandler:
	.type	EXTI3_IRQHandler, %function
	.thumb_func
EXTI3_IRQHandler:
	.type	EXTI4_IRQHandler, %function
	.thumb_func
EXTI4_IRQHandler:
	.type	EXTI5_IRQHandler, %function
	.thumb_func
EXTI5_IRQHandler:
	.type	EXTI6_IRQHandler, %function
	.thumb_func
EXTI6_IRQHandler:
	.type	EXTI7_IRQHandler, %function
	.thumb_func
EXTI7_IRQHandler:
	.type	EXTI8_IRQHandler, %function
	.thumb_func
EXTI8_IRQHandler:
	.type	EXTI9_IRQHandler, %function
	.thumb_func
EXTI9_IRQHandler:
	.type	EXTI10_IRQHandler, %function
	.thumb_func
EXTI10_IRQHandler:
	.type	EXTI11_IRQHandler, %function
	.thumb_func
EXTI11_IRQHandler:
	.type	EXTI12_IRQHandler, %function
	.thumb_func
EXTI12_IRQHandler:
	.type	EXTI13_IRQHandler, %function
	.thumb_func
EXTI13_IRQHandler:
	.type	EXTI14_IRQHandler, %function
	.thumb_func
EXTI14_IRQHandler:
	.type	EXTI15_IRQHandler, %function
	.thumb_func
EXTI15_IRQHandler:
	.type	ADC_IRQHandler, %function
	.thumb_func
ADC_IRQHandler:
	.type	GPTM0_IRQHandler, %function
	.thumb_func
GPTM0_IRQHandler:
	.type	SCTM0_IRQHandler, %function
	.thumb_func
SCTM0_IRQHandler:
	.type	SCTM1_IRQHandler, %function
	.thumb_func
SCTM1_IRQHandler:
	.type	PWM0_IRQHandler, %function
	.thumb_func
PWM0_IRQHandler:
	.type	BFTM0_IRQHandler, %function
	.thumb_func
BFTM0_IRQHandler:
	.type	BFTM1_IRQHandler, %function
	.thumb_func
BFTM1_IRQHandler:
	.type	I2C0_IRQHandler, %function
	.thumb_func
I2C0_IRQHandler:
	.type	I2C1_IRQHandler, %function
	.thumb_func
I2C1_IRQHandler:
	.type	SPI0_IRQHandler, %function
	.thumb_func
SPI0_IRQHandler:
	.type	SPI1_IRQHandler, %function
	.thumb_func
SPI1_IRQHandler:
	.type	USART0_IRQHandler, %function
	.thumb_func
USART0_IRQHandler:
	.type	UART0_IRQHandler, %function
	.thumb_func
UART0_IRQHandler:
	.type	UART1_IRQHandler, %function
	.thumb_func
UART1_IRQHandler:
	.type	SCI_IRQHandler, %function
	.thumb_func
SCI_IRQHandler:
	.type	USB_IRQHandler, %function
	.thumb_func
USB_IRQHandler:
	.type	PDMA_CH0_IRQHandler, %function
	.thumb_func
PDMA_CH0_IRQHandler:
	.type	PDMA_CH1_IRQHandler, %function
	.thumb_func
PDMA_CH1_IRQHandler:
	.type	PDMA_CH2_IRQHandler, %function
	.thumb_func
PDMA_CH2_IRQHandler:
	.type	PDMA_CH3_IRQHandler, %function
	.thumb_func
PDMA_CH3_IRQHandler:
	.type	PDMA_CH4_IRQHandler, %function
	.thumb_func
PDMA_CH4_IRQHandler:
	.type	PDMA_CH5_IRQHandler, %function
	.thumb_func
PDMA_CH5_IRQHandler:
	.type	AES_IRQHandler, %function
	.thumb_func
AES_IRQHandler:
                    B       .

	.balign 4

/* ******************************************************************************* */
/* User Stack and Heap initialization */
/* ******************************************************************************* */
	.global __HT_check_heap
	.global __HT_check_sp

	/* [keil2gnu] Keil __MICROLIB block removed (GNU toolchain uses __StackTop/_end) */


